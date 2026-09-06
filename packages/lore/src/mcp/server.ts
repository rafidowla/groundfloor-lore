#!/usr/bin/env node
/**
 * server.ts — Groundfloor Lore MCP Server (DAEMON entry).
 *
 * Purpose:
 *   Exposes the schema-agnostic Lore knowledge graph as an MCP server — a
 *   knowledge database for agentic AI serving any domain. Domain clients (e.g.
 *   Atlas for code intelligence) connect over it; the server is not code-specific.
 *
 * Architecture (W2-CORE-SPLIT):
 *   Service CONSTRUCTION now lives in the async `createLore()` factory
 *   (exported via packages/lore/src/index.ts). This file is the DAEMON
 *   entry: `main()` calls createLore() and then owns transport selection
 *   (stdio / --http), signal handlers, and process.exit. Importing this
 *   module no longer auto-boots a daemon — the boot at the bottom is gated
 *   on this file being the process entrypoint.
 *
 *   Uses @modelcontextprotocol/sdk for transport (stdio or HTTP).
 *   Delegates storage to LocalGraph (the embedded SurrealDB graph).
 *   Each tool maps to one or more graph operations.
 *
 * Transport:
 *   Default: stdio (stdin/stdout) — one IDE spawns one process.
 *   --http:  Streamable HTTP daemon on port 3847 — multiple IDEs share one process.
 *   The HTTP mode solves the graph engine's single-writer file lock constraint.
 *
 * Error Behavior: Returns MCP error responses; does not crash the server.
 * Side Effects: Reads/writes .lore/graph/ via LocalGraph.
 * Determinism: Non-deterministic (depends on database state).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { requireWorkspaceGraph } from '../engines/requireWorkspaceGraph.js';
import { bannerEngineName, bannerGraphPath } from '../engines/openWorkspaceGraph.js';
import { getAnalyticalCached } from './analyticalGetter.js';
import { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import { SyncEngineRegistry } from '../engines/syncEngineRegistry.js';
import { WorkspaceVerbatimResolver } from '../outbox/workspaceVerbatimResolver.js';
import { searchWorkerIsolationEnabled } from '../engines/verbatimSearchWorkerProxy.js';
import { VerbatimStore } from '../engines/verbatimStore.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { FeedbackStore } from '../engines/feedbackStore.js';
import { SyncEngine } from '../engines/syncEngine.js';
import { TsSdkAdapter } from '../engines/tsSdkAdapter.js';
import path from 'path';
import { SchemaLoader } from '../schemas/loader.js';
import { ConfigManager, resolveDeploymentMode } from '../config/configManager.js';
import { probeEmbeddingBackend } from '../providers/embeddingBackend.js';
import { ensureAuthToken, ensureBootstrapNonce, getAuthTokenPath } from '../security/authToken.js';
import { InMemoryReplayHandlerRegistry } from '../security/approvalReplay.js';
import { createCloudSyncClient } from '../sync/createCloudSyncClient.js';
import { SyncPoller } from '../sync/syncPoller.js';
import {
    readLocalWorkspaceStates,
    applySnapshotToDisk,
    removeWorkspaceFromDisk,
} from '../sync/syncCallbacks.js';
import { getActiveWorkspaceName, loadWorkspaces } from '../config/workspaces.js'; // L-033: loadWorkspaces resolves quota entries.
import { RateLimiter } from '../security/rateLimit.js'; import { InMemoryWorkspaceQuotaStore } from '../security/workspaceQuota.js'; // L-033: shared write-quota store.
import { buildDefaultRegistry, ExtractorRegistry } from '../engines/extractors/index.js';
import { RetentionSweeper } from '../engines/retentionSweep.js';
import { LocalFileSink } from '../engines/archive.js';
import { buildDefaultConnectors } from '../engines/connectors/index.js';
import { AuditLog } from '../security/audit.js'; import { wireAuditExporterOnBoot } from '../audit/wireExporter.js';
import { logEmbeddedWrite } from './embeddedAudit.js';
import { setCurrentUserProvider } from '../security/identity.js';
import { ConsentManager } from '../security/consent.js';
import { guardSyncDown } from '../security/syncDirectionGuard.js';
import { McpClientRuntime } from '../engines/mcpClient/runtime.js';
import { loreHome, resolveLoreHome } from '../config/loreHome.js';
import { startHttpLifecycle, makeDispose } from './lifecycle.js';
import { PoolExhaustedError, PoolAcquireTimeoutError } from '../engines/poolLimits.js';
import { WorkspaceAccessDeniedError } from '../security/routeWorkspaceBinding.js';
import { runEmbeddedInit, embeddedGuardedGraph, composeEmbeddedDrain, type GuardableGraph } from './embeddedLifecycle.js';
import { createMcpServer as createMcpServerImpl } from './createMcpServer.js';
import { createPhaseAServices } from './services.js';
import { createStorageClient } from './storageBundle.js';
import { wireOrchestration } from '../schemas/orchestration/wiring.js';
import { createActiveSessionTracker } from './activeSessions.js';
import type { TokenSweeperHandle } from '../auth/tokens.js';
import { wireDaemonTimers } from './daemonTimers.js';
import { buildMergedEnums } from './mergedEnums.js';
import { AuxStore } from '../outbox/auxStore.js';
import { VersionStore } from '../outbox/versionStore.js';
import { wireOutbox } from '../outbox/wiring.js';
import { wireEmbedQueue } from '../embed/wiring.js';
import { dispatchHttpRequest } from './http/dispatcher.js';
import { writeError } from './http/helpers.js';
import { LoadJobsStore } from '../storage/loadJobsStore.js';
import { wireLoadJobsRunner, type LoadJobsRunner } from '../storage/loadJobsRunner.js';
import { wireMigrationCoordinator, type MigrationDaemonWiring } from '../migration/daemonWiring.js';
import { WorkspaceConcurrencyManager, TempFileSweeper } from '../storage/loadJobsConcurrency.js';
import { StreamRegistry } from '../streaming/streamRegistry.js';
import { SqliteBulkLoaderAdapter } from '../bulkLoader/sqliteAdapter.js';
import { selectGraphBulkLoaderAdapter, type GraphBulkLoadHandle } from '../bulkLoader/selectGraphAdapter.js';
import { LanceBulkLoaderAdapter } from '../bulkLoader/lanceAdapter.js';
import {
    resolveWorkspaceScope,
    resolveGraphPath,
    runPermLockdown,
    runWorkspaceRegistryMigration,
    startExternalMcpClients,
    runLogRotation,
    runWorkspaceLogRotation,
    startFileWatcher, stopAllLocalWatchers,
    runBackgroundReconnectIfFresh,
    buildGraphRegistryForLocalMode,
    buildSyncEngineRegistryForLocalMode,
    primeWorkspaceVerbatimResolver,
    resolveToolTier,
    buildGraphReaders,
} from './bootSteps.js';
// SP-02 — ordered graceful-shutdown drain (extracted from this file).
import { buildShutdownDrain, collectSqliteStores } from './shutdownDrain.js';
// W3-SERVICE-LAYER — transport-agnostic guarded node-write orchestration,
// shared with the MCP store_node tool + POST /api/node route.
import { nodeUpsert as nodeServiceUpsert, resolveAutolinkHandles, type NodeWriteResult } from '../core/nodeService.js';
// 1.1 (2026-08-17 functional-correctness audit) — SurrealDB's optimistic
// concurrency drops writes under overlapping-key contention; the retry
// wrapper (previously wired ONLY into bulkIngest) now covers the embedded
// single/batch upsert paths too. No-op for engines that serialize writes internally.
import { withTransactionConflictRetry } from '../engines/transactionConflictRetry.js';
import { runBootEphemeralPrune } from './bootEphemeralPrune.js';
import { recordHotWriteBatch } from '../outbox/hotLane.js';
import { setTimeout as delayMs } from 'node:timers/promises';
import { runBulkIngest, mapLimit, type BulkIngestNodeArgs, type BulkIngestOpts, type BulkIngestResult } from './bulkIngest.js';
import { inProcessRecall, type RecallOpts, type RecallResult } from '../recall/inProcessRecall.js';
import { log } from '../logger.js';
// TW-2b — the native-pool process-global safety net is OPT-IN: only a process
// Lore OWNS (the daemon path) arms it; embedded createLore() never does, so it
// attaches no uncaughtException/unhandledRejection handlers to the host.
import { disposeNativePoolSafetyNet } from '../engines/nativePoolSafetyNet.js';
import { scrubEnvIfOwned, armNativePoolSafetyNetIfOwned, daemonTimersEnabled } from './processOwnership.js';
import {
    createGraph,
    createEmbeddingProvider,
    createVectorStore,
    createPendingOpsStore,
    resolveSyncAdapterFromEnv,
    runRetentionSweep as runRetentionSweepImpl,
    fireBootHealthPing as fireBootHealthPingImpl,
    maybeUpgradeAdapterFromKeychain as maybeUpgradeAdapterFromKeychainImpl,
    type DataplaneState,
    // cq-services-lore-graph-handle-duplicate — import the canonical substrate
    // unions rather than re-declaring them here.
    type LoreGraph,
    type LoreVectorStore,
} from './services.js';

/* ─── Library factory (W2-CORE-SPLIT) ─────────────────────────── */

/** Construction mode chosen by the publisher. `embedded` is finished in
 *  W3-EMBEDDED-MODE; today it constructs the same local substrates as
 *  `local` (no listeners, no process handlers). Cloud stays a first-class
 *  switchable backend (see cloud_invariant / DEC-CLOUD-READY). */
export type LoreDeploymentMode = 'local' | 'cloud' | 'embedded' | 'arcade';

/** Options for {@link createLore}. */
export interface CreateLoreOptions {
    /** Per-instance Lore data root. Threaded through resolveLoreHome so a
     *  host embedding Lore can pin one instance's home without mutating the
     *  process-wide LORE_HOME env var. */
    dataDir?: string;
    /** Publisher-chosen mode. Defaults to the env/config-resolved mode
     *  (LORE_DEPLOYMENT_MODE → config → 'local'). */
    deploymentMode?: LoreDeploymentMode;
    /**
     * Process ownership — TRUE only from the daemon entry `main()`; defaults to
     * FALSE so library consumers are safe. Gates the process-GLOBAL side effects
     * (env scrub, crash handlers). NOT `deploymentMode`: processOwnership.ts.
     */
    ownsProcess?: boolean;
    /**
     * Local embedding provider overrides. Programmatic alternative to the
     * LORE_LOCAL_EMBEDDING_DEVICE / LORE_LOCAL_EMBEDDING_MODEL env vars.
     * Values set here take precedence over env vars.
     *
     * ```ts
     * // Apple Silicon — CoreML (fastest on M-series)
     * createLore({ embedding: { device: 'coreml' } })
     *
     * // Cross-platform GPU (CUDA on NVIDIA, Metal-backed on Mac, etc.)
     * createLore({ embedding: { device: 'auto' } })
     *
     * // WebGPU — works in any environment with a modern GPU
     * createLore({ embedding: { device: 'webgpu' } })
     *
     * // NVIDIA CUDA (Linux/Windows with NVIDIA driver)
     * createLore({ embedding: { device: 'cuda' } })
     *
     * // Explicit CPU (the default — safe everywhere)
     * createLore({ embedding: { device: 'cpu' } })
     * ```
     *
     * `'auto'` is the recommended opt-in: it tries CoreML → CUDA → WebGPU → CPU
     * and falls back gracefully, so the same call works on every platform.
     * Check `/health.embeddingBackend` after startup to confirm which backend
     * was selected.
     */
    embedding?: import('../providers/localEmbeddingProvider.js').LocalEmbeddingProviderOptions;
}

/**
 * LoreInstance — the in-process handle returned by {@link createLore}.
 *
 * Exposes the constructed storage client / in-process ops plus the boot
 * wiring the DAEMON entry (`main()`) needs to start a transport. NO
 * listeners are open and NO process-level handlers/timers are registered
 * by createLore() in the library path — those are the daemon's job.
 *
 * `dispose()` runs the ordered graceful-shutdown drain (buildShutdownDrain)
 * so an embedding host can tear the instance down cleanly. The full
 * embedded transport + dispose wiring detail is finished in
 * W3-EMBEDDED-MODE.
 */
export interface LoreInstance {
    /** Unified storage bundle (sdk: GroundfloorClient in cloud mode, null in local mode). */
    readonly store: Awaited<ReturnType<typeof createStorageClient>>;
    /** Effective SUBSTRATE mode this instance was constructed for. 'embedded'
     *  collapses to 'local' here — the embedded distinction lives in
     *  {@link LoreInstance.runMode}. */
    readonly deploymentMode: 'local' | 'cloud';
    /** W3-EMBEDDED-MODE — the full publisher-selected run mode
     *  (embedded | local | cloud) this instance was constructed for. 'embedded'
     *  means in-process with no transport/port and host-owned dispose(). */
    readonly runMode: LoreDeploymentMode;
    /** Resolved Lore data root for this instance. */
    readonly dataHome: string;
    /** Factory for a fresh McpServer (stdio = once; HTTP = per session). */
    createMcpServer(): McpServer;
    /**
     * W3-SERVICE-LAYER — guarded in-process node write. Routes through the
     * SAME orchestration the MCP store_node tool + POST /api/node use
     * (outbox-first node.upsert + verbatim fan-out + rollback, WAL append,
     * version record, ingest autolink) so the embeddable API is no longer
     * strictly weaker than HTTP/MCP. The caller supplies the already-
     * normalised node record (the exact shape handed to `upsertNode`,
     * including `project`/`ecosystem`); transport gates (ReBAC, MCP scope,
     * principal default, quota) are NOT applied here — an in-process host
     * owns its own authorization. Cloud-mode safe: the target graph + outbox
     * + verbatim facade all support both backends.
     */
    nodeUpsert(args: {
        id: string;
        workspace: string;
        ecosystem: string;
        nodeData: Record<string, unknown>;
        skipEmbed?: boolean;
        asyncEmbed?: boolean;
    }): Promise<NodeWriteResult>;
    /**
     * Bulk-ingest N nodes optimised for structured import (repo indexing,
     * memory imports, migration tools). Fixes two trickle-ingest behaviours
     * that regress at bulk scale:
     *
     * 1. **Autolink OFF by default** — skips the per-node `reconnectOneNode`
     *    ONNX search. Pass `{ autolink: true }` to re-enable.
     * 2. **embed:'sync' by default** — when the returned promise resolves,
     *    every vector IS persisted to LanceDB. No drain race with dispose().
     *
     * Internally: one `embedDocumentBatch()` call for all N texts (3-5× vs N
     * serial single-embeds), then one `bulkAddPrebuiltRows()` to LanceDB.
     * Per-node errors are isolated — a failed node surfaces in `results[]`
     * without aborting the batch.
     *
     * `nodeUpsert` / `nodeUpsertBatch` are unchanged.
     */
    bulkIngest(
        nodes: import('./bulkIngest.js').BulkIngestNodeArgs[],
        opts?: import('./bulkIngest.js').BulkIngestOpts,
    ): Promise<import('./bulkIngest.js').BulkIngestResult>;
    /**
     * Batch variant of {@link nodeUpsert} — writes N nodes and returns N results
     * in the same order. Embeddings are forced async so all N texts are queued
     * together; the outbox dispatcher picks them up as one batch and calls
     * `embedDocumentBatch()` once, giving 3-5× throughput vs N serial single-embed
     * calls. Graph writes still run in parallel for maximum ingestion speed.
     *
     * Use when ingesting many nodes at once (e.g. indexing a codebase). For
     * one-off writes, `nodeUpsert()` is fine.
     */
    nodeUpsertBatch(nodes: Array<{
        id: string;
        workspace: string;
        ecosystem: string;
        nodeData: Record<string, unknown>;
        skipEmbed?: boolean;
    }>): Promise<NodeWriteResult[]>;
    /**
     * Resolves when all pending async embeds have been persisted to LanceDB.
     *
     * Nodes written via `nodeUpsert({ asyncEmbed: true })` or `nodeUpsertBatch`
     * are embedded in the background. If you need to query by vector similarity
     * immediately after a batch of trickle-ingests, await this first.
     *
     * Not needed after `bulkIngest({ embed: 'sync' })` — vectors are persisted
     * before that call returns. Call again if you ingest more nodes afterward.
     */
    awaitEmbeds(): Promise<void>;
    /** P2/Atlas — in-process hybrid recall (semantic+BM25+traversal). Returns a typed JS object; no MCP transport. */
    recall(topic: string, opts: RecallOpts): Promise<RecallResult>;
    /** P2/Atlas — vector+keyword node search. Thin wrapper over storageClient.search(); workspace/ecosystem default to '*'. */
    search(query: string, limit?: number, workspace?: string, ecosystem?: string): Promise<import('../providers/types.js').LoreNode[]>;
    /** Ordered async graceful-shutdown drain; does NOT close any HTTP server or call process.exit (daemon owns those).
     *  TW-7b: closes the graph engine + LanceDB handles deterministically LAST, so an embedder awaiting dispose() exits NATURALLY without process.exit() (no native SIGSEGV; idempotent). See test/tw2a-embedded-lifecycle-unit.ts. */
    dispose(reason?: string): Promise<void>;
    /**
     * cq-daemon-wiring-leaks-into-public-interface /
     * api-daemon-wiring-on-public-instance — the public embeddable surface
     * exposes ONLY the narrow {@link LoreInternalHandles}, not the ~50-field
     * DaemonWiring boot bag. Embedders see just the substrate handles a
     * cross-process consumer legitimately needs (graph registry + outbox
     * store). The full DaemonWiring still travels on this property at runtime
     * for the daemon entry; `main()` (same trusted module) re-widens it via an
     * internal cast. Underscore-prefixed: not a stable API.
     */
    readonly _daemon: LoreInternalHandles;
}

/**
 * LoreInternalHandles — the narrow internal surface the public LoreInstance
 * exposes via `_daemon`. Deliberately tiny: only the handles a cross-boundary
 * embedder/test reaches for (the per-workspace graph registry and the outbox
 * store). The daemon entry casts `_daemon` back to the full {@link DaemonWiring}
 * inside server.ts; it is never the public contract.
 */
export interface LoreInternalHandles {
    getGraphRegistry(): LocalGraphRegistry | undefined;
    outboxWiring: ReturnType<typeof wireOutbox>;
}

/**
 * DaemonWiring — the construction outputs the DAEMON entry consumes.
 *
 * Everything `main()` previously read from module scope now lives here.
 * Closures (maybeUpgradeAdapterFromKeychain / fireBootHealthPing /
 * runRetentionSweep / createMcpServer) close over the factory's locals
 * rather than module mutables, so importing the library triggers none of
 * them.
 */
interface DaemonWiring {
    deploymentMode: 'local' | 'cloud';
    graphBasePath: string;
    loreDir: string;
    /** hc-bulk-loader-dim-hardcoded — the active embedding provider, so the
     *  daemon's bulk-loader derives the vector dim from `.dimension` instead of
     *  a hardcoded 384. */
    embeddingProvider: EmbeddingProvider;
    detectedScope: ReturnType<typeof resolveWorkspaceScope>;
    domainSchema: ReturnType<SchemaLoader['get']>;
    schemaLoader: SchemaLoader;
    getGraph(): LoreGraph;
    verbatimStore: LoreVectorStore;
    getAdapter(): TsSdkAdapter | null;
    getSyncEngine(): SyncEngine;
    getWal(): ReturnType<SyncEngine['getWal']>;
    configManager: ConfigManager;
    store: Awaited<ReturnType<typeof createStorageClient>>;
    embedQueue: ReturnType<typeof wireEmbedQueue>;
    outboxWiring: ReturnType<typeof wireOutbox>;
    workspaceVerbatimResolver: WorkspaceVerbatimResolver | undefined; workspaceQuotaStore: import('../security/workspaceQuota.js').IWorkspaceQuotaStore; getWorkspaceEntryForQuota: (ws: string) => import('../config/workspaces.js').WorkspaceEntry | undefined; // L-033 shared write quota (REST + MCP).
    loadJobsStore: LoadJobsStore;
    loadConcurrencyManager: WorkspaceConcurrencyManager;
    loadTempFileSweeper: TempFileSweeper;
    streamRegistry: StreamRegistry;
    auditLog: AuditLog;
    feedbackStore: FeedbackStore;
    consentManager: ConsentManager;
    rateLimiter: RateLimiter;
    extractorRegistry: ExtractorRegistry;
    pendingOpsStore: ReturnType<typeof createPendingOpsStore>;
    replayRegistry: InMemoryReplayHandlerRegistry;
    cloudSync: ReturnType<typeof createCloudSyncClient>;
    syncPoller: SyncPoller;
    connectorRegistry: ReturnType<typeof buildDefaultConnectors>;
    archiveSink: LocalFileSink;
    retentionSweeper: RetentionSweeper;
    // TW-7d — only the async stop() is consumed (by the shutdown drain); the
    // raw SweepScheduler.timer is never read off the daemon bag. Narrowed so
    // the embedded inert handle (no live interval) satisfies the same field.
    consistencySweeper: { stop(): Promise<void> };
    /** HOUSEKEEPING — scheduled LanceDB compaction handle. Same narrowed
     *  stop()-only shape as consistencySweeper. */
    compactionSweeper: { stop(): Promise<void> };
    authTokenSweeper: TokenSweeperHandle;
    mcpClientRuntime: McpClientRuntime;
    activeSessions: ReturnType<typeof createActiveSessionTracker>['map'];
    touchActiveSession: ReturnType<typeof createActiveSessionTracker>['touch'];
    evictActiveSession: ReturnType<typeof createActiveSessionTracker>['evict'];
    orchestrationWiring: ReturnType<typeof wireOrchestration>;
    phaseAServices: ReturnType<typeof createPhaseAServices>;
    auxStore: AuxStore | undefined;
    versionStore: VersionStore | undefined;
    getGraphRegistry(): LocalGraphRegistry | undefined;
    setGraphRegistry(r: LocalGraphRegistry | undefined): void;
    /** Wave 4.3 — per-workspace SyncEngine registry. */
    getSyncEngineRegistry(): SyncEngineRegistry | undefined;
    setSyncEngineRegistry(r: SyncEngineRegistry | undefined): void;
    maybeUpgradeAdapterFromKeychain(): Promise<'keychain' | 'env' | 'none'>;
    fireBootHealthPing(): Promise<void>;
    getDataplaneState(): DataplaneState;
    runRetentionSweep(dryRun: boolean): ReturnType<typeof runRetentionSweepImpl>;
    createMcpServer(): McpServer;
}

/**
 * createLore — async factory performing all service CONSTRUCTION.
 *
 * Builds the graph, vector store, embedding provider, storage bundle, and
 * the MCP-server factory. Starts NO listeners and registers NO
 * process-level handlers/timers in the library path: env scrub, registry
 * migration, the embedding-provider await, and the boot sweep timers all
 * run HERE (at call time), so importing the package triggers none of them.
 *
 * Cloud mode (cloud_invariant / DEC-CLOUD-READY): when deploymentMode is
 * 'cloud', the cloud adapters (DataplaneGraph / DataplaneVectorStore) are
 * constructed exactly as before. W4-CLOUD-FACADE-ROUTING finishes cloud
 * routing through the unified contract; this factory preserves today's
 * cloud construction path.
 */
export async function createLore(opts: CreateLoreOptions = {}): Promise<LoreInstance> {
    // SP-17 — Parent-env scrub. MUST be the FIRST executed statement, ahead of
    // every construction-path env read below. Gated on OWNERSHIP: it mutates
    // shared process.env — the HOST's config when embedded (processOwnership.ts).
    scrubEnvIfOwned(opts.ownsProcess);

    // Phase 1 item 13 — best-effort projects.json → workspaces.json
    // migration BEFORE the first registry read so the daemon picks up
    // the canonical filename on a fresh boot.
    runWorkspaceRegistryMigration();

    // W0-DATADIR / W2-CORE-SPLIT — per-instance data root. resolveLoreHome
    // pins this instance's home from opts.dataDir without mutating the
    // process-wide LORE_HOME env. The legacy loreHome() shim (used by some
    // call sites below) still reads LORE_HOME; opts.dataDir threads through
    // resolveLoreHome where an explicit home is needed.
    const dataHome = resolveLoreHome({ dataDir: opts.dataDir });

    // TW-2a — thread `dataHome` through scope + graph-path resolution so
    // createLore({dataDir}) opens its graph under that root. Pre-TW-2a both
    // ignored opts.dataDir and fell back to the global LORE_HOME, so two
    // embedders collided on one on-disk graph. Daemon callers pass no dataDir
    // → dataHome === loreHome(), so the daemon path is unchanged.
    const detectedScope = resolveWorkspaceScope(dataHome);
    const graphBasePath = resolveGraphPath(dataHome);

    const schemaLoader = new SchemaLoader(graphBasePath);
    const domainSchema = schemaLoader.get();

    // Settings are read BEFORE graph construction so Q1.3 cache knobs
    // (enabled / ttlSeconds / maxEntries) flow into the ReadCache at
    // construction time. LORE_CACHE_DISABLED=1 still wins as the operator
    // killswitch inside LocalGraph; the settings path is the normal one.
    const loreDir = path.join(graphBasePath, '.lore');
    const configManager = new ConfigManager(loreDir);
    const bootConfig = configManager.read();
    const cacheCfg = bootConfig.localCache;
    const cacheTtlMs = Math.max(1, Math.min(3600, cacheCfg?.ttlSeconds ?? 60)) * 1000;
    const cacheMaxSize = Math.max(16, Math.min(50_000, cacheCfg?.maxEntries ?? 500));
    const cacheDisabled = cacheCfg?.enabled === false;

    // Q2.1 / W3-EMBEDDED-MODE — Resolve deployment mode. Precedence:
    // explicit opts.deploymentMode (publisher-chosen) > env
    // (LORE_DEPLOYMENT_MODE) > config > 'local'. This is publisher/config-time,
    // NOT a runtime auto-detect. `effectiveMode` carries the full three-way
    // choice (embedded | local | cloud) so the daemon entry (main()) can branch
    // on 'embedded' and so the substrate-initialization below knows to bring the
    // graph/vector handles up in the library path.
    const effectiveMode: LoreDeploymentMode =
        opts.deploymentMode ?? resolveDeploymentMode(bootConfig);

    // ARCADE-MODE (spike/arcadedb-multitenant, slice 2 W1) — the db-per-app
    // ArcadeDB cloud backend boots down a SEPARATE path that never brings up
    // the local graph engine/LanceDB/LocalGraphRegistry/sync/watchers. It
    // builds ONLY the daemon-local SQLite relational lane (outbox + audit +
    // provisioning registry) plus the operator control-plane + bounded
    // data-plane HTTP surface. Delegated to mcp/arcadeBoot.ts so server.ts
    // does not grow and the local/cloud substrate path below is provably untouched (additive).
    if (effectiveMode === 'arcade') {
        const { createArcadeInstance } = await import('./arcadeBoot.js');
        return createArcadeInstance({ dataHome, loreDir });
    }

    // `deploymentMode` is the SUBSTRATE mode threaded through every downstream
    // consumer (storage client, services, route gates). 'embedded' builds the
    // SAME local graph engine/LanceDB substrates as 'local' — it differs
    // only in the transport/lifecycle decision the daemon makes (no
    // listener, no signal handlers, host-owned dispose()). Cloud stays
    // first-class and switchable (cloud_invariant). The cloud-mode boot
    // preflight (adapter presence) runs inside main() below, after the keychain upgrade.
    const deploymentMode: 'local' | 'cloud' =
        effectiveMode === 'cloud' ? 'cloud' : 'local';

    // TW-2b — Arm the native-pool process-global safety net ONLY when Lore owns
    // the process. MUST run BEFORE the pools are constructed (createGraph below
    // + the LanceDB pool during verbatim init): their constructors call
    // installNativePoolSafetyNet(), which no-ops unless armed. Ownership — not
    // mode — is the predicate: processOwnership.ts.
    armNativePoolSafetyNetIfOwned(opts.ownsProcess, effectiveMode);

    // Local-mode audit identity: bind the OS username so audit entries read
    // "rafi ran recall()" rather than the placeholder "owner". In cloud mode,
    // clerkAuth.ts sets the actor from the Clerk JWT via bindActorToRequest —
    // no override needed there.
    if (deploymentMode === 'local') {
        const osUser = process.env['USER'] ?? process.env['USERNAME'] ?? 'owner';
        setCurrentUserProvider(() => ({ id: osUser, displayName: osUser, roles: ['operator'] }));
    }

    // Q2.2 — mode-conditional graph factory; full contract on `createGraph`.
    // Local mode opens the engine the ACTIVE WORKSPACE DECLARES; cloud mode
    // gets DataplaneGraph. `workspaceId` + `home` resolve that engine by NAME
    // against THIS dataHome rather than path-matching the global LORE_HOME.
    let graph: LoreGraph = await createGraph({
        deploymentMode,
        graphBasePath,
        workspaceId: getActiveWorkspaceName(dataHome),
        home: dataHome,
        cacheTtlMs,
        cacheMaxSize,
        cacheDisabled,
    });

    // Q2.2 slice 6a/6b/7 — single EmbeddingProvider injected into both
    // vector stores. Selection precedence (highest → lowest):
    //   1. LORE_EMBEDDING_PROVIDER=openai_compat → remote provider.
    //   2. LORE_LOCAL_EMBEDDING_MODEL=<modelId> → local override.
    //   3. (default) LocalEmbeddingProvider — Xenova/all-MiniLM-L6-v2.
    //
    // W2-CORE-SPLIT: the top-level `await createEmbeddingProvider()` moved
    // HERE (inside the factory) so importing the library never triggers the
    // embedding-provider load.
    const embeddingProvider: EmbeddingProvider = await createEmbeddingProvider(opts.embedding);
    // v1.1 (deferred item #3 partial): probe + log the actual ONNX runtime
    // backend so operators see ground truth instead of the legacy
    // "Wasm CPU" misnomer. Surfaced on /health and /api/health.
    try {
        const ortInfo = await probeEmbeddingBackend();
        if (!ortInfo.unknown) {
            log.info(`[Lore MCP] ORT backend: ${ortInfo.label}`);
        }
    } catch (probeErr) {
        log.warn(`[Lore MCP] ORT backend probe failed (non-fatal): ${(probeErr as Error).message}`);
    }

    // Q2.2 slice 3 — Mode-conditional vector-store factory.
    //   local mode: embedded LanceDB VerbatimStore at the active workspace path.
    //   cloud mode: DataplaneVectorStore fronting groundfloor-ts-sdk's vector
    //               extension. Both implement VectorProvider.
    const verbatimStore: LoreVectorStore = await createVectorStore({
        deploymentMode,
        graphBasePath,
        embeddingProvider,
        embedOverrides: opts.embedding as Record<string, unknown> | undefined,
    });

    // SP-F3 — per-workspace verbatim resolver for the outbox replicator (local mode).
    const workspaceVerbatimResolver = deploymentMode === 'cloud' ? undefined : new WorkspaceVerbatimResolver(embeddingProvider, searchWorkerIsolationEnabled(), opts.embedding as Record<string, unknown> | undefined); const workspaceQuotaStore = new InMemoryWorkspaceQuotaStore(); const getWorkspaceEntryForQuota = (ws: string) => loadWorkspaces().workspaces.find((w) => w.name === ws); // L-033 shared write quota (REST + MCP).

    // Architecture gap #2 — async embed queue (factory in embed/wiring.ts).
    // RA2-reaudit2 — resolveStores routes a job to its own workspace's graph +
    // verbatim store (lazy: graphRegistry is assigned later in boot, but the
    // executor only runs post-boot at drain time). Without it, a non-active
    // workspace's import embedded into the boot store (or silently skipped).
    const embedQueue = wireEmbedQueue({
        graph, vectorStore: verbatimStore,
        resolveStores: async (ws) => {
            if (!ws || !graphRegistry || !workspaceVerbatimResolver) return null;
            try {
                const g = await graphRegistry.getGraphHandle(ws);
                const v = await workspaceVerbatimResolver.getOrOpen(ws);
                return { graph: g, vectorStore: v };
            } catch { return null; }
        },
        // 1.M2 (2026-08-17 audit) — queue-overflow drops were silently
        // discarded (enqueue() return ignored at every call site, this hook
        // never wired). Re-enqueue a shed embed as a DURABLE outbox
        // embed.batch row so overflow degrades to replicator-drained async
        // instead of silent loss — this is also the recovery path in
        // embedded mode, where the consistency sweep never runs.
        onOverflow: (dropped) => {
            try {
                void recordHotWriteBatch(outboxWiring.store, [{
                    workspace: dropped.workspace || detectedScope.workspace,
                    operationKind: 'embed.batch',
                    payload: { texts: [dropped.text], targetNodeIds: [dropped.nodeId] },
                    initiator: 'embedQueue.overflow',
                    operation: 'embed.batch',
                }]).catch((err) => {
                    log.warn(`[embed-queue] overflow outbox fallback failed for ${dropped.nodeId}: ${(err as Error).message}`);
                });
            } catch {
                // Never throw from the overflow hook (TDZ-safe during boot).
            }
        },
    });

    // Phase 1 — Unified storage client (Dataplane SDK shape).
    const store = await createStorageClient(graph, verbatimStore, deploymentMode, graphBasePath);

    // Merge core vocabulary into store_node / store_edge enums.
    const { nodeTypesEnum, nodeTypesDescription, edgeRelationsEnum } =
        buildMergedEnums({
            coreNodeTypes: domainSchema.nodeTypes,
            coreEdgeRelations: domainSchema.edgeRelations,
        });

    // TW-6b: the keepEmbeddedModelHot config knob and its keep-hot seed
    // were removed with the chat surface. The embedded LLM (chat-only)
    // always idle-unloads; nothing to seed on boot.

    // Module-level mutables (now factory locals). main() may replace adapter
    // (and rebuild syncEngine) if the OS keychain has a dataplane credential.
    let adapter: TsSdkAdapter | null = resolveSyncAdapterFromEnv(deploymentMode);

    // Architecture gap #1 — durable outbox + recovery wiring (outbox/wiring.ts).
    const isLocal = deploymentMode !== 'cloud';
    // TW-2a — in embedded mode the host's in-process write applies the graph
    // node SYNCHRONOUSLY before the replicator sees the outbox row, so the
    // replicator's node.upsert re-apply is redundant AND races concurrent host
    // graph writes (single-writer graph engine). Wrap the graph the embedded outbox
    // writes through so an already-applied node.upsert becomes a no-op (boot
    // recovery of genuinely-unapplied prior-run rows still applies). Daemon /
    // local / cloud are untouched — only effectiveMode==='embedded' wraps.
    const guardEmbeddedGraph = <T extends GuardableGraph>(g: T): T =>
        effectiveMode === 'embedded' ? embeddedGuardedGraph(g) : g;
    // cq-server-wireoutbox-megaexpression — the local-mode outbox substrate
    // getters, broken out of the former 745-char single line into named local
    // closures so each getter (and its isLocal/registry/resolver guard) reads
    // top-to-bottom. Behaviour is unchanged: in cloud mode every getter is
    // `undefined` (the outbox replicator never re-applies); in local/embedded
    // they resolve the active or per-workspace substrate, with the embedded
    // graph wrapped so an already-applied node.upsert no-ops. Sprint
    // O2/SP-F2/SP-F3 substrate getters.
    const outboxGetGraph = isLocal
        // Engine-aware requireWorkspaceGraph, not a LocalGraph cast: the
        // boot graph is whichever engine the active workspace declares.
        ? () => guardEmbeddedGraph(requireWorkspaceGraph(graph, 'outbox replication', 'local-mode outbox substrate'))
        : undefined;
    const outboxGetVerbatim = isLocal
        ? () => verbatimStore as unknown as VerbatimStore
        : undefined;
    const outboxGetEmbedder = isLocal ? () => embeddingProvider : undefined;
    const outboxGetGraphForWorkspace = isLocal
        ? () =>
              // Was getOrOpen() (hardcoded to a single local graph implementation) — replicated writes for a Surreal workspace leaked into the wrong workspace's graph.
              graphRegistry
                  ? (ws: string) => graphRegistry!.getGraphHandle(ws).then(guardEmbeddedGraph)
                  : undefined
        : undefined;
    const outboxGetVerbatimForWorkspace = isLocal
        ? () =>
              workspaceVerbatimResolver
                  ? (ws: string) => workspaceVerbatimResolver.getOrOpen(ws)
                  : undefined
        : undefined;
    const outboxWiring = wireOutbox({
        loreDir,
        getSyncEngine: () => syncEngine,
        getGraph: outboxGetGraph,
        getVerbatim: outboxGetVerbatim,
        getEmbedder: outboxGetEmbedder,
        getGraphForWorkspace: outboxGetGraphForWorkspace,
        getVerbatimForWorkspace: outboxGetVerbatimForWorkspace,
    });
    // Sprint Z1 — load_jobs SQLite store backs POST /api/load + GET /api/load/jobs.
    const loadJobsStore = new LoadJobsStore(loreDir);
    // Sprint Z3 — shared per-workspace concurrency manager + temp-file sweeper.
    const loadConcurrencyManager = new WorkspaceConcurrencyManager();
    const loadTempFileSweeper = new TempFileSweeper({ store: loadJobsStore });
    // Sprint S — in-memory streaming-ingest registry.
    const streamRegistry = new StreamRegistry();
    let syncEngine: SyncEngine = new SyncEngine(graph, loreDir, deploymentMode === 'cloud' ? null : adapter, verbatimStore, outboxWiring.store);
    let wal = syncEngine.getWal();

    // S9 keychain preference. Thin closure injecting the factory-scope
    // mutables into the services-layer impl. Called once at main() startup.
    function maybeUpgradeAdapterFromKeychain(): Promise<'keychain' | 'env' | 'none'> {
        return maybeUpgradeAdapterFromKeychainImpl({
            deploymentMode,
            loreDir,
            getAdapter: () => adapter,
            getGraph: () => graph,
            verbatimStore,
            setAdapter: (a) => { adapter = a; },
            // Wave 4.3 — drop stale sibling engines (they hold the pre-upgrade
            // adapter by value); re-prime the boot entry with the new one.
            setSyncEngine: (s) => {
                syncEngine = s;
                syncEngineRegistry?.invalidateUnpinned();
                syncEngineRegistry?.prime(graphRegistry?.activeName() ?? detectedScope.workspace, syncEngine);
            },
            setWal: (w) => { wal = w; },
            setGraph: (g) => { graph = g; },
        });
    }

    // Phase 4 — Lightweight Dataplane health-ping. Fired once inside main()
    // AFTER the keychain upgrade so it observes the final adapter binding.
    let dataplaneState: DataplaneState = 'unknown';
    function fireBootHealthPing(): Promise<void> {
        return fireBootHealthPingImpl({
            getAdapter: () => adapter,
            configManager,
            setState: (s) => { dataplaneState = s; },
        });
    }
    function getDataplaneState(): DataplaneState {
        return dataplaneState;
    }

    // Phase 6 P1.C — graph registry. Initialized inside main() once
    // graph.initialize() resolves.
    let graphRegistry: LocalGraphRegistry | undefined;

    // Wave 4.3 — per-workspace SyncEngine registry; initialized alongside graphRegistry.
    let syncEngineRegistry: SyncEngineRegistry | undefined;

    // Feature 1/2/7 — AuxStore opened once at daemon boot. CLOUD MUST-FIX: boot-bound (shares VersionStore's per-tenant gap; see docs/CLOUD_GAP_AUDIT.md).
    let auxStore: AuxStore | undefined;
    try {
        auxStore = AuxStore.open(loreDir);
    } catch (auxOpenErr) {
        log.warn(`[Lore MCP] AuxStore open failed (non-fatal — lifecycle/outcome/health tools unavailable): ${(auxOpenErr as Error).message}`);
    }

    // Feature 8 — VersionStore opened once at daemon boot alongside AuxStore. CLOUD MUST-FIX: boot-bound = shared across workspaces; cloud multi-tenant needs a per-tenant store (see docs/CLOUD_GAP_AUDIT.md).
    let versionStore: VersionStore | undefined;
    try {
        versionStore = VersionStore.open(loreDir);
    } catch (vsErr) {
        log.warn(`[Lore MCP] VersionStore open failed (non-fatal — versioning tools unavailable): ${(vsErr as Error).message}`);
    }

    /**
     * S5 / W9 — rate limiter shared across all /api/* handlers.
     * SP-11 — autoSweep evicts idle per-principal buckets; sweep timer is
     * unref()'d; stopSweeper() runs in the graceful-shutdown drain.
     */
    const rateLimiter = new RateLimiter(deploymentMode, undefined, { autoSweep: true });

    /**
     * C3 (Phase 2) — extractor registry. Built with the shipped defaults
     * (text/markdown, PDF, DOCX, EML).
     */
    const extractorRegistry = buildDefaultRegistry();

    /** HITL second-party-approval queue + the replay-handler registry. */
    const pendingOpsStore = createPendingOpsStore(store);
    const replayRegistry = new InMemoryReplayHandlerRegistry();

    /** Cloud sync client + poller. NoCloudSyncClient when LORE_CLOUD_URL is
     *  unset. The poller is STARTED inside main() (after the HTTP server is
     *  up), not here — the library path opens no listeners. */
    const cloudSync = createCloudSyncClient();
    // TW-2a — instance-scoped workspaces dir (was loreHome() = process-global).
    const workspacesDir = path.join(dataHome, 'workspaces');
    const syncPoller = new SyncPoller({
        client: cloudSync.client,
        cloudIsAuthoritative: cloudSync.cloudIsAuthoritative,
        callbacks: {
            readLocalState: async () => readLocalWorkspaceStates(workspacesDir),
            applySnapshot: async (workspaceId, version, bytes) => {
                // L-035: gate the cloud→local persist on SyncDirectionGuard.
                // A 'cloud-only' workspace must NEVER have its snapshot
                // persisted to local disk (syncDirectionGuard.ts:11-14). The
                // generic poller is guard-agnostic by design, so the policy
                // check lives here in the host callback. Fail-CLOSED for
                // cloud-only; fail-OPEN for unknown-workspace (most cloud
                // workspaces are never registered locally — only the boot
                // workspace is, at line 636 — so a bare canSyncDown() would
                // default-deny ordinary local-first sync). The thrown error
                // is caught by syncPoller.ts:188-190 as a `pullsFailed` entry.
                guardSyncDown(phaseAServices.syncGuard, workspaceId);
                applySnapshotToDisk(workspacesDir, workspaceId, version, bytes);
            },
            removeWorkspace: async (workspaceId) => {
                removeWorkspaceFromDisk(workspacesDir, workspaceId, getActiveWorkspaceName());
            },
        },
    });

    /** C5 (Phase 2) — connector registry. Ships with FilesystemConnector. */
    const connectorRegistry = buildDefaultConnectors(extractorRegistry, graphBasePath);

    /** C6 (Phase 4) — audit log + consent manager. */
    const auditLog = new AuditLog({ path: path.join(dataHome, 'audit.jsonl') }); wireAuditExporterOnBoot(auditLog); // Sprint B-local — audit/wireExporter.ts
    // V2.2: thumbs-up/down feedback store.
    const feedbackStore = new FeedbackStore();
    const consentManager = new ConsentManager();

    // Phase 1 item 3 / Phase 4 item 8: the schema subsystem's engine-agnostic
    // graph-ops adapter. `getGraph` reads `graph` fresh so a keychain upgrade
    // reassignment is observed, per-call, on every SchemaGraphOps method.
    const { schemaGraphOps } = buildGraphReaders(() => graph, () => detectedScope.workspace);
    const phaseAServices = createPhaseAServices(loreDir, graphBasePath, schemaGraphOps);
    // Seed default workspace sync policy so sync_policy_get returns a row immediately.
    phaseAServices.syncGuard.register({ workspace: detectedScope.workspace, policy: 'local-first' });

    // Phase 4 items 4 + 10 — orchestration singletons + schema_approve replay.
    const orchestrationWiring = wireOrchestration({
        schemaGraphOps,
        loreDir,
        schemaAuthoring: phaseAServices.schemaAuthoring,
        schemaChangeAudit: phaseAServices.schemaChangeAudit,
        workspace: detectedScope.workspace,
        replayRegistry,
        startsDaemonTimers: daemonTimersEnabled(opts.ownsProcess, effectiveMode),
    });

    /** Phase 6 — retention sweep + archive sink. */
    const archiveSink = new LocalFileSink();
    const retentionSweeper = new RetentionSweeper(graph, auditLog);

    /** runRetentionSweep — thin closure injecting factory-scope deps. */
    function runRetentionSweep(dryRun: boolean) {
        return runRetentionSweepImpl({ graph, verbatimStore, auditLog }, dryRun);
    }

    // api-timers-started-in-all-modes — the daemon-only background sweepers
    // (retention auto-sweep, auth-registry sweep, consistency reconciliation)
    // must NOT start in a process Lore does not own: they can fire AFTER the
    // host calls dispose(), breaking the "no side effects in the library path"
    // contract. Gated on OWNERSHIP, not mode — an in-process host may pick any
    // deploymentMode (processOwnership.ts). Non-owners get inert handles with
    // the same shape (no live timer; stop()/clear() are no-ops).
    const startsDaemonTimers = daemonTimersEnabled(opts.ownsProcess, effectiveMode);

    // Daemon-only background sweepers (retention, auth-registry, consistency
    // reconciliation, scheduled storage compaction) — construction extracted
    // to daemonTimers.ts to keep this file inside the file-size baseline.
    // Every sweeper is gated behind `startsDaemonTimers` INSIDE that helper,
    // so none of them start in embedded mode.
    const { retentionScheduler, authTokenSweeper, consistencySweeper, compactionSweeper, versionPruneSweeper } = wireDaemonTimers({
        startsDaemonTimers,
        isLocal,
        runRetentionSweep,
        graph,
        verbatimStore,
        tableStorage: store.tableStorage,
        embedQueue,
        workspace: detectedScope.workspace,
        // RC-round4 — fan sweeps per-workspace (local). Lazy graphRegistry: assigned later in boot. See daemonTimers.
        workspaceVerbatimResolver, auditLog, graphRegistry: { getGraphHandle: (ws: string) => graphRegistry!.getGraphHandle(ws), tableStorageFor: (ws: string) => graphRegistry!.tableStorageFor(ws) }, versionStore });

    /** C6b (Phase 4) — MCP client runtime (connects outward to external MCP servers). */
    const mcpClientRuntime = new McpClientRuntime();

    // Active HTTP-transport session tracker (Audit 2026-05-13).
    const activeSessionTracker = createActiveSessionTracker();
    const activeSessions = activeSessionTracker.map;
    const touchActiveSession = activeSessionTracker.touch;
    const evictActiveSession = activeSessionTracker.evict;

    /**
     * createMcpServer — Factory for a fresh, fully-configured McpServer.
     * In stdio mode called once; in HTTP mode called per client session
     * (McpServer binds to a single transport and cannot be reused).
     */
    function createMcpServer(): McpServer {
        return createMcpServerImpl({
            store,
            configManager,
            auditLog,
            schemaLoader,
            extractorRegistry,
            getSyncEngine: () => syncEngine,
            getSyncAdapter: () => adapter,
            getWal: () => wal,
            detectedScope,
            loreDir,
            graphBasePath,
            deploymentMode, runMode: effectiveMode, // ITEM 3 (launch-fixes-2026-08) — un-collapsed run mode so schema_approve's HITL gate refuses destructive approvals in embedded mode.
            nodeTypesEnum,
            nodeTypesDescription,
            edgeRelationsEnum,
            domain: domainSchema.domain,
            edgeRelations: domainSchema.edgeRelations,
            resolveToolTier,
            phaseA: phaseAServices,
            embedQueue,
            graphRegistry,
            workspaceVerbatimResolver, // L-025/L-026 — verbatim tools route to the requested workspace's LanceDB.
            pendingOpsStore,
            coreNodeTypes: domainSchema.nodeTypes,
            auxStore,
            versionStore,
            outboxStore: outboxWiring.store, outboxLagCache: outboxWiring.lagCache, quotaStore: workspaceQuotaStore, getWorkspaceEntryForQuota, // SP-F3 outbox rows + L-033 MCP store_node shared write quota.
        });
    }

    // SP-02 — ordered async drain (shutdownDrain.ts). Used by both the daemon
    // lifecycle onShutdown AND the embeddable dispose(). Does NOT close the
    // HTTP server or call process.exit. getLoadJobsRunner / migrationWiring
    // are closures because the daemon assigns them later in boot; for a pure
    // library instance they stay null/undefined (no runner is started).
    let loadJobsRunner: LoadJobsRunner | null = null;
    let migrationWiring: MigrationDaemonWiring | null = null;
    const buildOrderedDrain = () => buildShutdownDrain({
        graph, store,
        verbatimStore,
        syncPoller,
        outboxReplicator: outboxWiring.replicator,
        embedQueue,
        consistencySweeper,
        compactionSweeper,
        versionPruneSweeper,
        getLoadJobsRunner: () => loadJobsRunner,
        migrationWiring: migrationWiring ?? undefined,
        authTokenSweeper,
        rateLimiter,
        graphRegistry, syncEngineRegistry, workspaceVerbatimResolver,
        sqliteStores: collectSqliteStores({ outboxStore: outboxWiring.store, auxStore, versionStore, pendingOpsStore, tableStorage: store.tableStorage }),
        stopAllLocalWatchers,
    });
    // TW-2b — after the ordered drain completes, remove any process-global
    // safety-net listeners Lore installed (daemon path only — embedded never
    // armed it, so this is a no-op there). This restores the host/process
    // listener set exactly as it was before Lore. Covers BOTH dispose triggers:
    // the embedded host-called dispose() and the daemon coordinator onShutdown,
    // since both run through buildDrain().
    const buildDrain = (): ((reason: string) => Promise<void>) => {
        const ordered = buildOrderedDrain();
        return async (reason: string): Promise<void> => {
            try {
                await ordered(reason);
            } finally {
                try { disposeNativePoolSafetyNet(); } catch { /* non-fatal */ }
            }
        };
    };
    // TW-2a — the embedded teardown ALSO clears the createLore()-time timers
    // the shared ordered drain leaves running (retention bootstrap, active-
    // session sweep, orchestration tick). These never bit the long-lived
    // daemon, so the daemon's onShutdown drain is unchanged; only the embedded
    // dispose() / init-throw cleanup composes them in so an embedding host's
    // event loop is left clean.
    const buildEmbeddedDrain = () => composeEmbeddedDrain(buildDrain(), {
        retentionBootstrapTimer: retentionScheduler.bootstrapTimer,
        activeSessionsSweepTimer: activeSessionTracker.sweepTimer,
        orchestrationTickTimer: orchestrationWiring.tickTimer,
        // wireAuditExporterOnBoot attaches asynchronously (configure().then(start)
        // .then(attachExporter)), so getExporter() may still be null if dispose()
        // races boot — stop() is then simply skipped (nothing armed yet).
        stopAuditExporter: () => auditLog.getExporter()?.stop(),
    });

    const daemon: DaemonWiring = {
        deploymentMode,
        graphBasePath,
        loreDir,
        embeddingProvider,
        detectedScope,
        domainSchema,
        schemaLoader,
        getGraph: () => graph,
        verbatimStore,
        getAdapter: () => adapter,
        getSyncEngine: () => syncEngine,
        getWal: () => wal,
        configManager,
        store,
        embedQueue,
        outboxWiring,
        workspaceVerbatimResolver, workspaceQuotaStore, getWorkspaceEntryForQuota,
        loadJobsStore,
        loadConcurrencyManager,
        loadTempFileSweeper,
        streamRegistry,
        auditLog,
        feedbackStore,
        consentManager,
        rateLimiter,
        extractorRegistry,
        pendingOpsStore,
        replayRegistry,
        cloudSync,
        syncPoller,
        connectorRegistry,
        archiveSink,
        retentionSweeper,
        consistencySweeper,
        compactionSweeper,
        authTokenSweeper,
        mcpClientRuntime,
        activeSessions,
        touchActiveSession,
        evictActiveSession,
        orchestrationWiring,
        phaseAServices,
        auxStore,
        versionStore,
        getGraphRegistry: () => graphRegistry,
        // 1.2 (2026-08-17 audit) — when the registry lands, also wire the
        // storage facade's per-workspace read routers so
        // store.storageClient.getNode/listNodes/search/getStats +
        // verbatimSearch/verbatimCount can reach non-boot workspaces
        // (previously every facade read hit the boot graph).
        setGraphRegistry: (r) => {
            graphRegistry = r;
            if (!r) return;
            store.storageClient.setWorkspaceRouters({
                graphForWorkspace: (ws) => r.getGraphHandle(ws),
                ...(workspaceVerbatimResolver
                    ? { verbatimForWorkspace: (ws: string) => workspaceVerbatimResolver.getOrOpen(ws) }
                    : {}),
            });
        },
        getSyncEngineRegistry: () => syncEngineRegistry,
        setSyncEngineRegistry: (r) => { syncEngineRegistry = r; },
        maybeUpgradeAdapterFromKeychain,
        fireBootHealthPing,
        getDataplaneState,
        runRetentionSweep,
        createMcpServer,
    };

    // W3-EMBEDDED-MODE / TW-2a — bring the substrates up in-process (the
    // embedded path has no daemon main() to do it). 'local'/'cloud'
    // construction stays lazy (main() owns init) so the daemon boot ordering
    // is byte-for-byte unchanged.
    if (effectiveMode === 'embedded') {
        // TW-2a — full embedded substrate readiness (init + instance-scoped
        // registry + resolver prime + in-process replication start), wrapped
        // so any init throw runs the SAME ordered drain dispose() uses before
        // rethrowing. Extracted to embeddedLifecycle.ts to keep server.ts in
        // its file-size baseline. NO port / NO process handler is opened here.
        await runEmbeddedInit({
            deploymentMode,
            graph,
            verbatimStore,
            workspaceVerbatimResolver,
            detectedWorkspace: detectedScope.workspace,
            dataHome,
            outboxWiring,
            setGraphRegistry: (r) => {
                graphRegistry = r;
                if (!r) return;
                store.storageClient.setWorkspaceRouters({
                    graphForWorkspace: (ws) => r.getGraphHandle(ws),
                    ...(workspaceVerbatimResolver
                        ? { verbatimForWorkspace: (ws: string) => workspaceVerbatimResolver.getOrOpen(ws) }
                        : {}),
                });
            },
            buildDrain: buildEmbeddedDrain,
        });
    }

    return {
        store,
        deploymentMode,
        runMode: effectiveMode,
        dataHome,
        createMcpServer,
        // W3-SERVICE-LAYER — guarded in-process write through the SAME
        // orchestration the MCP/REST transports use (outbox + embed queue +
        // WAL + version + local autolink). Resolves the target graph via the
        // registry when wired (else boot graph); isActive mirrors P1.C gating.
        //
        // Audit fix #1: embedded writes are now audit-logged. The MCP/HTTP
        // transports wrap every write with `withMcpAudit`; the embedded path
        // previously wrote with NO audit row — leaving no trail for apps that
        // integrate via createLore() (the recommended path for Atlas et al).
        // The embedded principal is fixed to 'lib' (no transport principal).
        async nodeUpsert(args) {
            const startedAt = Date.now();
            let value: NodeWriteResult | undefined;
            let error: unknown;
            try {
                const isActive = args.workspace === (graphRegistry?.activeName() ?? detectedScope.workspace);
                // getGraphHandle resolves the target workspace's own declared
                // engine — resolving the wrong graph here would land an
                // embedded write where nothing reads it.
                const targetGraph: LoreGraph = graphRegistry ? await graphRegistry.getGraphHandle(args.workspace) : graph;
                const previousState = versionStore ? await targetGraph.getNode(args.id) : null;
                // Audit fix #5: route the autolink (reconnect) hook to the TARGET
                // workspace's graph + verbatim, not the boot/active stores. The
                // prior hardcode (store.loreGraph / store.loreVerbatim) let a
                // write into workspace B's vector content leak into workspace A's
                // search index. The boot stores are still the fallback when no
                // per-workspace resolver exists (e.g. cloud mode). Shared via
                // resolveAutolinkHandles since 2026-08-19 (launch-readiness item 4).
                const autolink = await resolveAutolinkHandles({
                    bootGraph: store.loreGraph,
                    bootVerbatim: store.loreVerbatim,
                    resolver: workspaceVerbatimResolver,
                    workspace: args.workspace,
                    targetGraph,
                    tracker: store.autolinkTracker,
                });
                value = await withTransactionConflictRetry(() => nodeServiceUpsert(
                    { ...args, targetGraph, initiator: 'lib:nodeUpsert', isActiveWorkspace: isActive },
                    {
                        outboxStore: outboxWiring.store, embedQueue, verbatim: store.storageClient,
                        getWal: () => wal, versionStore, previousState, versionPrincipal: 'lib',
                        autolink,
                    },
                ));
            } catch (err) {
                error = err;
            }
            // Audit fix #1: every embedded write appends exactly one audit row.
            return logEmbeddedWrite(
                { auditLog, toolName: 'lib:nodeUpsert', workspace: args.workspace, nodeId: args.id, startedAt },
                error !== undefined ? { ok: false, error } : { ok: true, value: value! },
            );
        },
        async nodeUpsertBatch(nodes) {
            // 4.4 (2026-08-17) — bound the fan-out: an unchunked Promise.all
            // overflowed the previous graph engine's native connection-pool waiter queue (200/200) past ~200 nodes.
            // 16 matches bulkIngest's proven BULK_INGEST_CONCURRENCY.
            const results = await mapLimit(nodes, 16, async (n) => {
                const startedAt = Date.now();
                let value: NodeWriteResult | undefined;
                let error: unknown;
                try {
                    const isActive = n.workspace === (graphRegistry?.activeName() ?? detectedScope.workspace);
                    const targetGraph: LoreGraph = graphRegistry ? await graphRegistry.getGraphHandle(n.workspace) : graph;
                    const previousState = versionStore ? await targetGraph.getNode(n.id) : null;
                    // Audit fix #5: route autolink to the TARGET workspace's stores (shared resolveAutolinkHandles, 2026-08-19).
                    const autolink = await resolveAutolinkHandles({
                        bootGraph: store.loreGraph,
                        bootVerbatim: store.loreVerbatim,
                        resolver: workspaceVerbatimResolver,
                        workspace: n.workspace,
                        targetGraph,
                        tracker: store.autolinkTracker,
                    });
                    value = await withTransactionConflictRetry(() => nodeServiceUpsert(
                        { ...n, asyncEmbed: true, targetGraph, initiator: 'lib:nodeUpsertBatch', isActiveWorkspace: isActive },
                        {
                            outboxStore: outboxWiring.store, embedQueue, verbatim: store.storageClient,
                            getWal: () => wal, versionStore, previousState, versionPrincipal: 'lib',
                            autolink,
                        },
                    ));
                } catch (err) {
                    error = err;
                }
                // C3-medium (2026-08-17) — per-node isolation. logEmbeddedWrite
                // RETHROWS after writing its audit row (contract: audit never
                // swallows a failure); uncaught, that rejection aborted the
                // whole mapLimit Promise.all, so a batch that PARTIALLY landed
                // (e.g. one SurrealDB transaction conflict among 50 nodes) was
                // reported to the caller as entirely failed and every sibling
                // result was lost. The audit row is already written by the time
                // it throws; convert the throw into this node's failure slot so
                // the rest of the batch still returns.
                try {
                    return logEmbeddedWrite(
                        { auditLog, toolName: 'lib:nodeUpsertBatch', workspace: n.workspace, nodeId: n.id, startedAt },
                        error !== undefined ? { ok: false, error } : { ok: true, value: value! },
                    );
                } catch (err) {
                    return {
                        ok: false as const,
                        code: 'write_failed' as const,
                        error: err instanceof Error ? err : new Error(String(err)),
                    };
                }
            });
            return results;
        },
        bulkIngest(nodes, opts) {
            return runBulkIngest(nodes ?? [], opts ?? {}, {
                graph,
                graphRegistry: graphRegistry ?? null,
                activeWorkspaceName: () => graphRegistry?.activeName() ?? detectedScope.workspace,
                outboxStore: outboxWiring.store,
                embedQueue,
                verbatimStore,
                storageClient: store.storageClient,
                loreVerbatim: store.loreVerbatim,
                embeddingProvider,
                getWal: () => wal,
                versionStore,
                // R4 #4 — each node's vector → ITS workspace's LanceDB; tracker → ITS dispose().
                workspaceVerbatimResolver, autolinkTracker: store.autolinkTracker,
            });
        },
        awaitEmbeds: async () => {
            await embedQueue.drained();
            // 1.M1 (2026-08-17 audit) — when the outbox is wired (the
            // default), embeds flow through outbox rows (verbatim.upsert /
            // embed.batch) drained by the replicator, NOT the in-memory
            // embedQueue — so drained() alone resolved instantly while the
            // documented "vectors are persisted" barrier did not hold and
            // an immediate recall returned a confident false negative.
            // Pump the replicator until no workspace has pending/failed
            // outbox rows, time-bounded so a poison row can't hang the
            // host (its retry budget exhausts to 'dead' in the background).
            const pendingLister = outboxWiring.store.listWorkspacesWithPending?.bind(outboxWiring.store);
            const tick = (outboxWiring.replicator as { tickOnce?: () => Promise<number> }).tickOnce;
            if (!pendingLister || typeof tick !== 'function') return;
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const pendingWs = await pendingLister();
                if (pendingWs.length === 0) return;
                // Safe alongside the running loop: dispatch is idempotent
                // (verbatim mergeInsert / node upsert), and when the loop
                // is NOT running (test mode) this is the only drain.
                await tick.call(outboxWiring.replicator);
                await delayMs(25);
            }
        },
        recall: (topic, opts) => inProcessRecall(topic, opts, { store, graphRegistry: graphRegistry ?? undefined, workspaceVerbatimResolver }),
        // 1.2 (2026-08-17 audit) — `workspace` now actually ROUTES (via the
        // facade's per-workspace read routers) instead of silently landing
        // in the `project` positional of the boot graph. '*' keeps the
        // legacy boot-graph read.
        search: (query, limit = 20, workspace = '*', ecosystem = '*') =>
            store.storageClient.search(query, limit, '*', ecosystem, { workspace: workspace === '*' ? undefined : workspace }),
        // W3-EMBEDDED-MODE — host-owned dispose. makeDispose wraps the ordered
        // drain (built once over this instance's live singletons) into an
        // idempotent async dispose that is fully decoupled from signal handlers
        // and the shutdownCoordinator — an embedding host tears down explicitly.
        // TW-2a — the embedded run mode composes in the extra createLore()-time
        // timer cleanup (retention/active-session/orchestration); local/cloud
        // library instances keep the plain ordered drain (daemon-owned).
        dispose: makeDispose(effectiveMode === 'embedded' ? buildEmbeddedDrain() : buildDrain()),
        _daemon: daemon,
    };
}

/* ─── Server Start (DAEMON entry) ─────────────────────────────── */

/** Default port for HTTP daemon mode. Override with LORE_PORT env var. */
const LORE_HTTP_PORT = parseInt(process.env['LORE_PORT'] ?? '3847', 10);

/**
 * hc-log-rotation-interval — in-uptime log-rotation cadence. Default 30 min
 * (unchanged); a positive integer in LORE_LOG_ROTATION_MS overrides it without
 * a recompile. Invalid/absent falls back to the default.
 */
const DEFAULT_LOG_ROTATION_MS = 30 * 60 * 1000; // 30 minutes
const LOG_ROTATION_MS = (() => {
    const raw = Number(process.env['LORE_LOG_ROTATION_MS']);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOG_ROTATION_MS;
})();

/**
 * main — Initialize graph and start MCP server.
 *
 * Purpose:
 *   Supports two transport modes:
 *   - stdio (default): each IDE spawns its own process.
 *   - HTTP (--http flag): single daemon, multiple IDEs connect via HTTP.
 *
 * W2-CORE-SPLIT: main() now CALLS createLore() for all construction, then
 * owns transport selection, signal handlers, and process.exit. Behavior is
 * preserved — the same boot ordering and wiring, just sourced from the
 * factory instead of module scope.
 *
 * W3-EMBEDDED-MODE: a THIRD branch sits ahead of the local/cloud daemon boot.
 * When the resolved run mode is 'embedded', createLore() has already brought
 * the substrates up in-process; main() returns the LoreInstance straight away
 * WITHOUT creating any transport (no StdioServerTransport, no HTTP listen),
 * WITHOUT registering SIGINT/SIGTERM handlers, and WITHOUT calling
 * process.exit — the embedding host owns the lifecycle and calls dispose().
 * The local AND cloud branches below are untouched (cloud_invariant).
 *
 * Side Effects: Opens the graph database; for local/cloud also starts a
 *   listener (stdio or HTTP) and signal handlers. Embedded opens no listener.
 * Error Behavior: Exits process with code 1 (or 78) on fatal startup error
 *   (local/cloud only — embedded never calls process.exit).
 */
async function main(): Promise<LoreInstance | void> {
    // Runs only behind `isProcessEntrypoint()` — precisely "Lore owns this
    // process". The ONE site allowed to claim ownership (processOwnership.ts).
    const lore = await createLore({ ownsProcess: true });

    // W3-EMBEDDED-MODE — embedded run mode: in-process, no transport, no signal
    // handlers, no process.exit. createLore() already initialized the
    // substrates; hand the usable instance back and stop here. Falls THROUGH to
    // the unchanged local/cloud daemon boot for every other mode.
    if (lore.runMode === 'embedded') {
        log.info('[Lore MCP] Deployment mode: embedded (in-process; no transport, no signal handlers)');
        return lore;
    }

    // ARCADE-MODE (slice 2 W1) — the arcade instance carries its own listener
    // starter on `_daemon`. main() only opens the transport under --http (same
    // gate as local/cloud), so `tsx server.ts` without --http constructs the
    // relational lane + provisioning registry and returns without binding a
    // port (used by the boot smoke check). The listener owns its own signal
    // handlers + drain.
    if (lore.runMode === 'arcade') {
        const arcade = lore._daemon as unknown as import('./arcadeBoot.js').ArcadeDaemonHandle;
        if (process.argv.includes('--http')) {
            await arcade.startArcadeListener();
        } else {
            log.info('[Lore MCP] Deployment mode: arcade (constructed; --http not set, no listener bound)');
        }
        return lore;
    }

    // cq-daemon-wiring-leaks-into-public-interface — the public LoreInstance
    // exposes `_daemon` as the narrow LoreInternalHandles. The daemon entry
    // (this same trusted module) re-widens it to the full DaemonWiring it
    // constructed; the full bag travels on the property at runtime.
    const d = lore._daemon as unknown as DaemonWiring;
    const {
        deploymentMode,
        graphBasePath,
        loreDir,
        detectedScope,
        domainSchema,
        schemaLoader,
        verbatimStore,
        configManager,
        store,
        embedQueue,
        outboxWiring,
        loadJobsStore,
        loadConcurrencyManager,
        loadTempFileSweeper,
        streamRegistry,
        auditLog,
        feedbackStore,
        consentManager,
        rateLimiter,
        extractorRegistry,
        pendingOpsStore,
        replayRegistry,
        cloudSync,
        syncPoller,
        connectorRegistry,
        archiveSink,
        retentionSweeper,
        consistencySweeper,
        compactionSweeper,
        authTokenSweeper,
        mcpClientRuntime,
        activeSessions,
        touchActiveSession,
        evictActiveSession,
        orchestrationWiring,
        phaseAServices,
        auxStore,
        versionStore,
    } = d;
    // S3 — localhost auth token. Populated below from <home>/auth.token.
    let authToken = '';
    // Local mutables the daemon wires after the --http gate (mirror the
    // pre-split module-level lets). The shutdown drain reads them via closures.
    let loadJobsRunner: LoadJobsRunner | null = null;
    let migrationWiring: MigrationDaemonWiring | null = null;

    runPermLockdown(graphBasePath);
    startExternalMcpClients(mcpClientRuntime);

    // Architecture gap #1 — replay any outbox entries left unfinished by the
    // previous run. Best-effort; never blocks boot.
    await outboxWiring.runBootRecovery();

    // Sprint O1 — start the universal-write replicator. Per the O1 hard
    // constraint the replicator must NOT start in test mode — gated by the
    // --http daemon flag (same flag that gates HTTP-server startup below).
    if (process.argv.includes('--http')) {
        outboxWiring.replicator.start();

        // Sprint Z2 — start the substrate-native loader runner. Same --http
        // gate as the replicator: test mode constructs but never starts.
        loadJobsRunner = wireLoadJobsRunner({
            store: loadJobsStore,
            outboxStore: outboxWiring.store,
            concurrencyManager: loadConcurrencyManager,
            sweeper: loadTempFileSweeper,
            buildDispatcherDeps: async (_job) => {
                const localVerbatim = deploymentMode === 'cloud' ? null : (verbatimStore as unknown as VerbatimStore);
                const sqlite = new SqliteBulkLoaderAdapter({ loreDir });
                // See selectGraphAdapter.ts for why the graph adapter is
                // chosen by capability, not by class.
                const handle = d.getGraph() as GraphBulkLoadHandle;
                const { surreal } = selectGraphBulkLoaderAdapter(handle);
                let lance: LanceBulkLoaderAdapter | undefined;
                if (localVerbatim) {
                    // hc-bulk-loader-dim-hardcoded — derive the loader's vector
                    // dim from the ACTIVE embedding provider (1536 openai_compat
                    // / 1024 / 384 local) instead of a hardcoded 384, with an
                    // explicit LORE_BULK_LOADER_DIM operator override. A bad
                    // override falls back to the provider's real dimension so a
                    // typo can't silently corrupt prebuilt LanceDB rows.
                    const dimOverride = Number(process.env['LORE_BULK_LOADER_DIM']);
                    const dim = Number.isInteger(dimOverride) && dimOverride > 0
                        ? dimOverride
                        : d.embeddingProvider.dimension;
                    lance = new LanceBulkLoaderAdapter({
                        vectorDim: dim,
                        addRows: async (rows) => {
                            await localVerbatim.bulkAddPrebuiltRows(rows as unknown as Array<Record<string, unknown>>);
                        },
                        // C3-medium (2026-08-17) — wire the documented Sprint Z3
                        // resume-idempotency hook. Without deleteIds the write
                        // path is a bare append, so a crash-resume re-added the
                        // post-checkpoint window as duplicate same-id canonical
                        // vector rows (mergeInsert can't help — this path is
                        // bulkAddPrebuiltRows by design; the adapter does
                        // delete-then-add per chunk when deleteIds is present).
                        deleteIds: async (ids) => {
                            await localVerbatim.physicalDeleteMany(ids);
                        },
                    });
                }
                return { sqlite, surreal, lance };
            },
        });
        loadJobsRunner.start();

        // Sprint H4 — wire MigrationCoordinator into the live daemon.
        try {
            migrationWiring = wireMigrationCoordinator({
                loreDir,
                outboxStore: outboxWiring.store,
                verbatim: deploymentMode === 'cloud' ? undefined : (verbatimStore as unknown as VerbatimStore),
            });
            log.info('[Lore MCP] Migration coordinator: wired (sqlite + lance adapters)');
        } catch (migErr) {
            log.warn(`[Lore MCP] Migration coordinator wiring failed (non-fatal): ${(migErr as Error).message}`);
        }
    }

    // S9 — upgrade Dataplane adapter from keychain if available. Env remains
    // the backward-compat fallback. Rebuilds syncEngine + wal on upgrade.
    try {
        const source = await d.maybeUpgradeAdapterFromKeychain();
        if (source === 'keychain') {
            log.info('[Lore MCP] Dataplane credential: keychain');
        } else if (source === 'env') {
            log.warn('[Lore MCP] Dataplane credential: env (consider moving to keychain)');
        }
    } catch (kcErr) {
        log.warn(`[Lore MCP] Keychain upgrade failed (non-fatal): ${(kcErr as Error).message}`);
    }

    // Q2.1 — Server mode preflight. Runs AFTER the keychain upgrade so the
    // adapter binding has settled. Cloud mode MUST have a Dataplane adapter.
    log.info(`[Lore MCP] Deployment mode: ${deploymentMode}`);
    if (deploymentMode === 'cloud' && !d.getAdapter()) {
        log.error(
            '[Lore MCP] FATAL — cloud mode requires a Dataplane credential. ' +
            "Set one via `security add-generic-password -a dataplane -s groundfloor-lore -w <token> -U` " +
            'or DATAPLANE_API_KEY env. To run without Dataplane, unset ' +
            "LORE_DEPLOYMENT_MODE (or set it to 'local').",
        );
        process.exit(78); // EX_CONFIG — config is valid but insufficient
    }

    // Q1.1 — Dataplane runtime binding. Fire the boot health-ping AFTER the
    // adapter has been resolved (env → keychain upgrade). Fire-and-forget.
    void d.fireBootHealthPing();

    runLogRotation();
    // RA2-reaudit2 — runLogRotation truncates audit.jsonl in place; reset the
    // audit chain head so the first post-rotation entry starts a fresh valid
    // chain (else verifyChain false-positives on a dangling prevHash).
    auditLog.onRotated();
    runWorkspaceLogRotation(loreDir);
    // Audit 2026-05-13: also rotate periodically during the daemon's lifetime.
    // hc-log-rotation-interval — cadence is env-overridable (LORE_LOG_ROTATION_MS).
    const logRotationInterval = setInterval(() => {
        try { runLogRotation(); auditLog.onRotated(); } catch { /* best-effort */ }
    }, LOG_ROTATION_MS);
    if (typeof logRotationInterval.unref === 'function') logRotationInterval.unref();

    // S3 — ensure the localhost auth token exists. Written with 0600.
    const dataHome = loreHome();
    authToken = ensureAuthToken(dataHome); ensureBootstrapNonce(dataHome); // one-time /api/auth/bootstrap nonce — a stale one from a killed daemon's prior boot must not authorize THIS instance; see authToken.ts + middleware.ts
    log.info(`[Lore MCP] Auth token at ${getAuthTokenPath(dataHome)} (0600)`);

    await d.getGraph().initialize();

    await verbatimStore.initialize();

    // Fix #5 — prune expired ephemeral nodes at startup. Non-fatal. ITEM
    // boot-pruneeph (2026-09) — see mcp/bootEphemeralPrune.ts.
    void runBootEphemeralPrune({ graph: d.getGraph(), workspace: detectedScope.workspace, outboxStore: outboxWiring.store, workspaceVerbatimResolver: d.workspaceVerbatimResolver, verbatimStore });

    const toolTier = resolveToolTier();
    if (toolTier !== 'default') {
        log.info(`[Lore MCP] Tool tier: ${toolTier} (LORE_TOOL_TIER)`);
    }

    await startFileWatcher({ graph: d.getGraph(), verbatimStore: verbatimStore instanceof VerbatimStore ? verbatimStore : undefined });

    // v1.1 background first-install reconnect (2026-04-30). Skipped in cloud mode.
    if (deploymentMode === 'local') {
        // requireWorkspaceGraph, not requireLocalGraph: needs a local ENGINE,
        // not the removed LocalGraph class, which would now refuse a Surreal boot workspace.
        const localGraph = requireWorkspaceGraph(d.getGraph(), 'backgroundReconnect', 'local-mode boot path');
        if (!(verbatimStore instanceof VerbatimStore)) {
            throw new Error('backgroundReconnect: local mode requires VerbatimStore');
        }
        await runBackgroundReconnectIfFresh({
            loreDir, graph: localGraph, verbatim: verbatimStore,
            // Per-instance, seal-gated, abortable — see backgroundReconnect.ts.
            tracker: d.store.sweepTracker,
        });
    }

    // Attempt Dataplane connection if adapter is configured
    const adapter = d.getAdapter();
    if (adapter) {
        try {
            await adapter.connect();
            log.info(`[Lore MCP] Sync: ONLINE — connected to Dataplane`);
        } catch (syncConnError) {
            log.warn(`[Lore MCP] Sync: OFFLINE — Dataplane unreachable (${(syncConnError as Error).message})`);
        }
    } else {
        log.info(`[Lore MCP] Sync: OFFLINE — no Dataplane credentials configured`);
    }

    // Phase 6 P1.B/P1.C — multi-workspace registry (see bootSteps).
    const graphRegistry = buildGraphRegistryForLocalMode(deploymentMode, d.getGraph(), detectedScope.workspace);
    d.setGraphRegistry(graphRegistry);

    // SP-F3 — prime the per-workspace verbatim resolver with the boot store.
    primeWorkspaceVerbatimResolver(d.workspaceVerbatimResolver, verbatimStore as unknown as import('../engines/verbatimStore.js').VerbatimStore, detectedScope.workspace);

    // Wave 4.3 — per-workspace SyncEngine registry (see bootSteps). routes/sync.ts
    // now resolves push/pull/now/status against the CALLER's workspace.
    const syncEngineRegistry = buildSyncEngineRegistryForLocalMode({
        graphRegistry,
        workspaceVerbatimResolver: d.workspaceVerbatimResolver,
        getAdapter: () => d.getAdapter(),
        outboxStore: outboxWiring.store,
        deploymentMode,
        bootSyncEngine: d.getSyncEngine(),
        activeWorkspace: detectedScope.workspace,
    });
    d.setSyncEngineRegistry(syncEngineRegistry);

    const useHttp = process.argv.includes('--http');

    if (useHttp) {
        // HTTP daemon mode — per-session McpServer+transport pairs.
        const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
            dispatchHttpRequest(req, res, {
                port: LORE_HTTP_PORT,
                deploymentMode, runMode: lore.runMode, // ITEM 3 (launch-fixes-2026-08) — full run mode threaded to the schema-approve HITL gate (embedded refusal).
                detectedScope,
                graphBasePath,
                loreDir, dataHome,
                store,
                configManager,
                schemaLoader,
                auditLog,
                consentManager,
                feedbackStore,
                rateLimiter,
                retentionSweeper,
                archiveSink,
                mcpClientRuntime,
                connectorRegistry,
                extractorRegistry,
                activeSessions,
                touchActiveSession,
                evictActiveSession,
                pendingOpsStore,
                replayRegistry,
                dataplane: deploymentMode === 'cloud'
                    ? (store.sdk as import('groundfloor-ts-sdk').GroundfloorClient)
                    : null,
                getAuthToken: () => authToken,
                getSharedSecret: () => process.env['LORE_MCP_AUTH_TOKEN'] || undefined,
                getSyncEngine: () => d.getSyncEngine(),
                getSyncAdapter: () => d.getAdapter(),
                syncEngineRegistry: d.getSyncEngineRegistry(),
                runRetentionSweep: d.runRetentionSweep,
                getDataplaneState: d.getDataplaneState,
                resolveToolTier,
                createMcpServer: d.createMcpServer,
                phaseA: phaseAServices,
                migrationBackend: orchestrationWiring.migrationBackend,
                migrationCheckpointStore: orchestrationWiring.migrationCheckpointStore,
                planOrchestrator: orchestrationWiring.planOrchestrator,
                embedQueue,
                graphRegistry, workspaceVerbatimResolver: d.workspaceVerbatimResolver, quotaStore: d.workspaceQuotaStore, getWorkspaceEntryForQuota: d.getWorkspaceEntryForQuota, // L-018 routing + L-033 REST shares the MCP write-quota store.
                coreNodeTypes: domainSchema.nodeTypes,
                getOutboxStats: () => outboxWiring.store.aggregateStats!(), outboxStore: outboxWiring.store, outboxLagCache: outboxWiring.lagCache,
                loadJobsStore, loadJobsRunner: loadJobsRunner ?? undefined,
                loadConcurrencyManager,
                streamRegistry,
                getAnalytical: getAnalyticalCached(deploymentMode, store),
                auxStore,
                versionStore,
            }).catch((err: unknown) => {
                if (err instanceof PoolExhaustedError || err instanceof PoolAcquireTimeoutError) {
                    log.warn(`[Lore MCP] pool overloaded, returning 503: ${(err as Error).message}`);
                    if (!res.headersSent) {
                        // Wave 5 cleanup: {code, message} envelope; Retry-After needs a manual writeHead.
                        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
                        res.end(JSON.stringify({ code: 'server_overloaded', message: 'server is at capacity, try again shortly' }));
                    }
                    return;
                }
                // Wave 4.1 — a workspace-confinement violation (an undeclared or
                // leaky route opening a workspace outside its binding) surfaces as a
                // 403 with the canonical {code, message} envelope (Wave 5 cleanup;
                // same code/status), NOT a 500 — the fail-closed backstop for
                // deny-by-default: a route that forgot bindRouteTarget still can't
                // reach foreign substrate — the open throws and lands here.
                if (err instanceof WorkspaceAccessDeniedError) {
                    log.warn(`[Lore MCP] workspace confinement denied: ${err.message}`);
                    if (!res.headersSent) {
                        writeError(res, 403, err.code, err.message);
                    }
                    return;
                }
                log.error(`[Lore MCP] uncaught dispatchHttpRequest error: ${(err as Error)?.stack ?? String(err)}`);
                if (!res.headersSent) {
                    writeError(res, 500, 'internal_error', 'internal error');
                }
            });
        });

        startHttpLifecycle({
            httpServer,
            port: LORE_HTTP_PORT,
            graphBasePath,
            detectedScope,
            // SP-02 — ORDERED async drain (shutdownDrain.ts). getLoadJobsRunner
            // is a closure because loadJobsRunner is assigned earlier in boot
            // (under the --http gate above).
            // TW-2b — wrap so the daemon's process-global safety-net listeners
            // are removed once the ordered drain completes, restoring the
            // process listener set on a clean daemon shutdown.
            onShutdown: ((orderedDrain: (reason: string) => Promise<void>) => async (reason: string): Promise<void> => {
                try {
                    await orderedDrain(reason);
                } finally {
                    try { disposeNativePoolSafetyNet(); } catch { /* non-fatal */ }
                }
            })(buildShutdownDrain({
                graph: d.getGraph(), store: d.store,
                verbatimStore,
                syncPoller,
                outboxReplicator: outboxWiring.replicator,
                embedQueue,
                consistencySweeper,
                compactionSweeper,
                getLoadJobsRunner: () => loadJobsRunner,
                migrationWiring: migrationWiring ?? undefined,
                authTokenSweeper,
                rateLimiter,
                graphRegistry, syncEngineRegistry, workspaceVerbatimResolver: d.workspaceVerbatimResolver,
                sqliteStores: collectSqliteStores({ outboxStore: outboxWiring.store, auxStore: d.auxStore, versionStore: d.versionStore, pendingOpsStore: d.pendingOpsStore, tableStorage: d.store.tableStorage }),
                stopAllLocalWatchers,
            })),
        });
        syncPoller.start();
        log.info(`[Lore MCP] Cloud sync: ${cloudSync.kind}${cloudSync.baseUrl ? ` (${cloudSync.baseUrl})` : ''}`);
    } else {
        // stdio mode — backward compatible, one IDE per process
        const server = d.createMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);

        log.info(`[Lore MCP] Server v1.0.0 started on stdio.`);
        log.info(`[Lore MCP] Graph: ${bannerGraphPath(graphBasePath)}`);
        log.info(`[Lore MCP] Scope: workspace=${detectedScope.workspace}, ecosystem=${detectedScope.ecosystem}\n[Lore MCP] Engine: ${bannerEngineName(graphBasePath)} (unified graph)`);
    }
}

/**
 * W2-CORE-SPLIT — boot gate. main() runs ONLY when this file is the process
 * entrypoint (the daemon bin / `tsx server.ts` / `node server.js`). When
 * server.ts is merely imported (e.g. transitively from
 * packages/lore/src/index.ts, the embeddable library entry), main() does NOT
 * run — so importing the library opens no port and never calls process.exit.
 */
function isProcessEntrypoint(): boolean {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    try {
        return fileURLToPath(import.meta.url) === argv1;
    } catch {
        return false;
    }
}

if (isProcessEntrypoint()) {
    main().catch((startupError) => {
        const err = startupError as Error;
        const msg = err?.message ?? String(startupError);
        // Turn the cryptic native-ABI mismatch into an actionable message: it
        // means a prebuilt native module (SurrealDB / LanceDB / better-sqlite3)
        // was compiled for a different Node.js major than the one now running.
        if (/NODE_MODULE_VERSION/.test(msg)) {
            log.error(
                `[Lore MCP] Failed to start — a native module was built for a DIFFERENT Node.js version than the one running.\n` +
                `  Running Node: ${process.version} (module ABI ${process.versions.modules}).\n` +
                `  Fix: this repo pins Node in .nvmrc (CI uses Node 22) — run \`nvm use\`, then retry; ` +
                `or rebuild the native modules for the current Node with \`npm rebuild\`.\n` +
                `  Original: ${msg.split('\n')[0]}`,
            );
        } else {
            log.error(`[Lore MCP] Failed to start: ${err?.stack ?? String(startupError)}`);
        }
        process.exit(1);
    });
}
