/**
 * createMcpServer.ts — Per-session McpServer factory.
 *
 * In stdio mode this is called once at boot. In HTTP mode it's called
 * per `/mcp` session because McpServer binds to a single transport and
 * cannot be reused — see mcp/http/routes/mcp.ts.
 *
 * Construction order matters and matches the original inline factory:
 *   1. New McpServer
 *   2. Optional lazy-tool-shim registry (LORE_TOOL_SHIM=on)
 *   3. Tool-dispatch logging wrapper around mcpServer.tool() (default on,
 *      LORE_TOOL_DISPATCH_LOG=0 opts out)
 *   4. Lazy-shim intercept *after* the dispatch wrapper so captured
 *      handlers carry instrumentation
 *   5. Each register<Family>Tools() registers its tools (now wrapped)
 *   6. Q1.2 provenance loop stamps every core tool with
 *      `_meta.provenance: 'core'`
 *   7. Lazy-shim installShims swaps the captured registry for three
 *      lore_tool_* shim tools (when shim mode is on)
 *
 * (Pre-v3.11.0 a pluginRegistry.registerTools step ran between 6 and 7 to
 * register external tools with a `provenance` stamp. The
 * plugin system was removed in v3.11.0.)
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from '../version.js';
import type { SyncEngine, WriteAheadLog } from './../engines/syncEngine.js';
import type { TsSdkAdapter } from './../engines/tsSdkAdapter.js';
import type { ConfigManager } from './../config/configManager.js';
import type { AuditLog } from './../security/audit.js';
import type { SchemaLoader } from './../schemas/loader.js';
import type { LoreDeploymentMode } from './server.js';
import type { ExtractorRegistry } from './../engines/extractors/index.js';
import type { LocalGraphRegistry } from './../engines/localGraphRegistry.js';
import type { PendingOpsStore } from './../security/pendingOps.js';
import { appendToolDispatch } from './../engines/toolDispatchLog.js';
import { createLazyToolRegistry } from './../engines/lazyToolShim.js';
import { registerDiagnosticTools } from './tools/diagnostic.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerTraverseTool } from './tools/traverse.js';
import { registerSearchTools } from './tools/search.js';
import { registerGovernanceTools } from './tools/governance.js';
import { registerIngestionTools } from './tools/ingestion.js';
import { registerVerbatimTools } from './tools/verbatim.js';
import { registerCollectionTools } from './tools/collections.js';
import { registerAnalyticalTools } from './tools/analytical.js';
import { createAnalyticalStorage } from './../engines/analyticalStorageFactory.js';
import type { IAnalyticalStorage } from './../contracts/index.js';
import { makeWorkspaceAnalyticalResolver } from './../engines/analyticalResolver.js';
import { registerPhaseATools } from './phaseATools.js';
import { registerLifecycleTools } from './tools/lifecycle.js';
import { registerOutcomeTools } from './tools/outcomes.js';
import { registerEvidenceTools } from './tools/evidence.js';
import { registerAnchorTools } from './tools/anchors.js';
import { registerCorpusHealthTools } from './tools/corpusHealth.js';
import { registerVersioningTools } from './tools/versioning.js';
import { registerMaintainTools } from './tools/maintain.js';
import type { PhaseAServices, StorageBundle } from './services.js';
import type { AuxStore } from '../outbox/auxStore.js';
import type { VersionStore } from '../outbox/versionStore.js';
import type { OutboxStore } from '../outbox/types.js';
import type { OutboxLagCache } from '../outbox/lagCache.js';

export interface CreateMcpServerDeps {
    /** Phase 2 unified storage handle. */
    store: StorageBundle;
    configManager: ConfigManager;
    auditLog: AuditLog;
    schemaLoader: SchemaLoader;
    extractorRegistry: ExtractorRegistry;

    /** Mutable singletons replaced post-keychain-upgrade — read fresh per call. */
    getSyncEngine: () => SyncEngine;
    getSyncAdapter: () => TsSdkAdapter | null;
    getWal: () => WriteAheadLog;

    /** Boot-time scope/mode/dirs. */
    detectedScope: { workspace: string; ecosystem: string };
    loreDir: string;
    graphBasePath: string;
    deploymentMode: 'local' | 'cloud';
    /**
     * ITEM 3 (launch-fixes-2026-08) — the instance's FULL run mode
     * (`LoreInstance.runMode`), which keeps the embedded|daemon
     * distinction `deploymentMode` above deliberately collapses
     * ('embedded' builds the same 'local' substrates). Threaded into
     * PhaseAContext so schema_approve's mandatory-HITL gate can refuse
     * destructive proposals at proposal time in embedded mode — the
     * HTTP-only confirmation step can never be reached there. Required:
     * server.ts's createMcpServer() closure always has `effectiveMode`
     * in scope, and a missing mode would silently re-open the enqueue-
     * forever hang this field exists to close.
     */
    runMode: LoreDeploymentMode;

    /** Pre-merged enums (core + workspace-contributed types). */
    nodeTypesEnum: ReturnType<typeof z.enum>;
    nodeTypesDescription: string;
    edgeRelationsEnum: ReturnType<typeof z.enum>;

    /** Domain config — passed to memory tools for descriptors. */
    domain: string;
    edgeRelations: string[];

    /** Tool-tier resolver (env-driven). */
    resolveToolTier: () => 'default' | 'slim' | 'opt-in';

    /** Phase A.5 governance + schema + audit singletons. */
    phaseA: PhaseAServices;

    /** Architecture gap #2 — async embed queue. When wired, store_node
     *  honors the opt-in `async_embed: true` flag by enqueuing the
     *  embed instead of blocking on it. Optional so legacy callers
     *  + tests pass undefined and the sync path runs unchanged. */
    embedQueue?: { enqueue: (nodeId: string, text: string) => void };

    /**
     * Phase 6 P1.C — multi-workspace LocalGraph registry. Threaded
     * into memory + search tools so MCP-tool callers (stdio AND
     * HTTP-MCP transport) can target a specific workspace per request
     * via the `workspace:` arg, and so recall can aggregate across
     * workspaces via `workspace: "*"`.
     *
     * Optional so cloud-mode boots and tests that don't wire a
     * registry continue using the boot-bound `store.loreGraph`.
     */
    graphRegistry?: LocalGraphRegistry;

    /**
     * L-025/L-026 — per-workspace VerbatimStore resolver. Threaded into
     * the verbatim tools so search_verbatim / get_verbatim / store_verbatim
     * route to the REQUESTED workspace's LanceDB instead of the boot-bound
     * global store. Optional so cloud-mode (resolver undefined there) and
     * tests that don't wire it keep the boot-singleton fallback.
     */
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<import('../engines/verbatimStore.js').VerbatimStore> };

    /**
     * Phase 6 P2 — pending-ops store for HITL routing of writes whose
     * type doesn't match the workspace's vocabPolicy with
     * onMismatch='hitl'. Optional so cloud-mode (where HITL flows
     * through the Dataplane approval service) and test fixtures can
     * pass undefined.
     */
    pendingOpsStore?: PendingOpsStore;

    /**
     * SP-F3 — outbox hot-lane store. When wired, the MCP write tools
     * (store_node / store_edge / delete_node) record an outbox row before
     * the substrate write, exactly like the REST routes (postNode.ts /
     * edges.ts). This gives MCP-originated writes the same durability +
     * crash-recovery-replay + replication coverage the "outbox is the
     * universal write path" invariant promises. Optional so cloud mode and
     * test fixtures that don't wire an outbox keep the prior direct-write
     * behavior. Pair with `outboxLagCache` for backpressure parity.
     */
    outboxStore?: OutboxStore;
    /** SP-F3 — per-workspace lag cache for MCP-write backpressure (O4),
     *  mirroring the REST `checkOutboxBackpressure` gate. Optional. */
    outboxLagCache?: OutboxLagCache;

    /**
     * L-033 — per-workspace write-quota store + entry resolver. Threaded into
     * the memory tools so MCP store_node enforces the SAME quota the REST POST
     * /api/node hot path does (one shared IWorkspaceQuotaStore instance). The
     * boot site passes the identical references it gives the dispatcher so the
     * counter is consistent across surfaces. Optional so cloud mode + tests
     * that don't wire it keep the prior no-quota behavior. */
    quotaStore?: import('../security/workspaceQuota.js').IWorkspaceQuotaStore;
    getWorkspaceEntryForQuota?: (workspace: string) => import('../config/workspaces.js').WorkspaceEntry | undefined;

    /** Core node-type vocabulary (no plugin contributions). */
    coreNodeTypes: ReadonlyArray<string>;

    /**
     * Feature 1/2/7 — auxiliary SQLite store for outcomes, prune jobs,
     * and corpus counters. Optional so cloud-mode and test fixtures that
     * don't need these features can omit it; lifecycle/outcome/health
     * tools return a clean error when absent.
     */
    auxStore?: AuxStore;
    /**
     * Feature 8 — version history + changeset store. Optional: when
     * wired, node_history / diff_workspace / begin_changeset /
     * commit_changeset / rollback_changeset / export_snapshot tools
     * are registered, and write tools auto-record version entries.
     */
    versionStore?: VersionStore;
}

export function createMcpServer(deps: CreateMcpServerDeps): McpServer {
    const mcpServer = new McpServer({
        name: 'groundfloor-lore',
        version: VERSION,
    });

    // v1.1.1 (P0 of the §3 Phase 6 strategy): lazy-schema tool
    // catalogue. When LORE_TOOL_SHIM=on, every subsequent
    // mcpServer.tool() call is captured into an in-process registry
    // instead of registered with MCP. At end-of-createMcpServer we
    // install three shims (lore_tool_list, lore_tool_schema,
    // lore_tool_invoke) that route discovery + invocation through the
    // registry. Saves ~5-10k tokens per session at MCP `tools/list` time.
    //
    // Default OFF — agents that don't know about the shim see only the
    // three lore_tool_* tools and can't auto-discover the catalogue.
    const shimEnabled = (process.env['LORE_TOOL_SHIM'] ?? '').trim().toLowerCase() === 'on';
    const lazyRegistry = shimEnabled ? createLazyToolRegistry() : null;

    // v1.1 (deferred item #6): tool-dispatch instrumentation. Wrap
    // mcpServer.tool() once at construction time so every tool handler
    // — across all 30+ tools registered by core + plugins — emits one
    // JSONL line on every call, capturing tool name, latency, success,
    // and (when the SDK exposes it) the session id. Output lands at
    // <loreDir>/tool-dispatch.jsonl. Opt out via LORE_TOOL_DISPATCH_LOG=0.
    if (process.env['LORE_TOOL_DISPATCH_LOG'] !== '0') {
        const originalTool = (mcpServer.tool as unknown as (...args: unknown[]) => unknown).bind(mcpServer);
        (mcpServer as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
            // The SDK's variadic signature is
            // (name, [description], [schema], handler).
            // Handler is always the last positional. Wrap it.
            const name = String(args[0] ?? '');
            const handlerIdx = args.length - 1;
            const original = args[handlerIdx];
            if (typeof original !== 'function') {
                return originalTool(...args);
            }
            const wrapped = async (...handlerArgs: unknown[]) => {
                const startNs = process.hrtime.bigint();
                const ts = new Date().toISOString();
                // SDK passes a context object as a trailing arg on most
                // tool calls; sessionId may live there. Best-effort
                // lookup; empty string when not exposed.
                const sessionId = (() => {
                    for (const a of handlerArgs) {
                        if (a && typeof a === 'object' && '_sessionId' in (a as object)) {
                            return String((a as { _sessionId: unknown })._sessionId ?? '');
                        }
                    }
                    return '';
                })();
                try {
                    const result = await (original as (...inner: unknown[]) => unknown)(...handlerArgs);
                    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
                    appendToolDispatch(deps.loreDir, { ts, sessionId, tool: name, elapsedMs, ok: true, error: '' });
                    return result;
                } catch (err) {
                    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
                    const msg = (err as Error).message ?? String(err);
                    appendToolDispatch(deps.loreDir, { ts, sessionId, tool: name, elapsedMs, ok: false, error: msg.slice(0, 500) });
                    throw err;
                }
            };
            const newArgs = args.slice();
            newArgs[handlerIdx] = wrapped;
            return originalTool(...newArgs);
        };
    }

    // v1.1.1 (P0): if shim mode is enabled, install the registry
    // intercept here — AFTER the dispatch-log wrapper so captured
    // handlers carry the dispatch-log instrumentation. Order matters:
    // the last wrap applied is outermost.
    if (lazyRegistry) {
        lazyRegistry.intercept(mcpServer);
    }

    // ── Core tool families ───────────────────────────────────────
    // Each family registers via register<Family>Tools(mcpServer, deps).
    // Provenance ('core' vs external) is stamped by the Q1.2
    // loop below — these all run before that loop so they get marked
    // as core.

    registerIngestionTools(mcpServer, {
        store: deps.store,
        extractorRegistry: deps.extractorRegistry,
        getWal: deps.getWal,
        detectedScope: deps.detectedScope,
        graphBasePath: deps.graphBasePath,
        graphRegistry: deps.graphRegistry,
    });

    registerGovernanceTools(mcpServer, {
        store: deps.store,
        getSyncEngine: deps.getSyncEngine,
        graphRegistry: deps.graphRegistry,
        detectedScope: deps.detectedScope,
        // ITEM X-pruneeph (2026-09-03) — prune_ephemeral's hard-delete path
        // needs these to record outbox rows + tombstone the requested
        // workspace's verbatim store (mirrors registerLifecycleTools below).
        outboxStore: deps.outboxStore,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver,
    });

    registerSearchTools(mcpServer, {
        store: deps.store,
        detectedScope: deps.detectedScope,
        graphRegistry: deps.graphRegistry,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver, // P2 — non-active recall seeds its own verbatim store.
    });

    registerTraverseTool(mcpServer, { store: deps.store, graphRegistry: deps.graphRegistry, detectedScope: deps.detectedScope });

    registerMemoryTools(mcpServer, {
        store: deps.store,
        configManager: deps.configManager,
        auditLog: deps.auditLog,
        detectedScope: deps.detectedScope,
        getWal: deps.getWal,
        domain: deps.domain,
        edgeRelations: deps.edgeRelations,
        nodeTypesEnum: deps.nodeTypesEnum,
        nodeTypesDescription: deps.nodeTypesDescription,
        edgeRelationsEnum: deps.edgeRelationsEnum,
        embedQueue: deps.embedQueue,
        graphRegistry: deps.graphRegistry,
        pendingOpsStore: deps.pendingOpsStore,
        coreNodeTypes: deps.coreNodeTypes,
        versionStore: deps.versionStore,
        outboxStore: deps.outboxStore,
        outboxLagCache: deps.outboxLagCache,
        quotaStore: deps.quotaStore, // L-033 — MCP store_node enforces the shared write quota.
        getWorkspaceEntryForQuota: deps.getWorkspaceEntryForQuota, // L-033.
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver, // L-056 — delete_node tombstones in the resolved workspace.
        inlineVerbatim: deps.deploymentMode === 'cloud' ? deps.store.storageClient : undefined,
    });

    /* ─── Step #5a: universal Core surfaces (verbatim + analytical) ─ */
    registerVerbatimTools(mcpServer, {
        store: deps.store,
        workspaceVerbatimResolver: deps.workspaceVerbatimResolver,
    });

    // Phase 2 item 4 — SDK-aligned collection_* MCP tools backed by
    // ITableStorage (SqliteTableStorage in local mode; cloud-mode stub
    // throws not-yet-implemented). See packages/lore/src/mcp/tools/
    // collections.ts and project_phase2_investigation_2026_05_15.
    registerCollectionTools(mcpServer, {
        tableStorage: deps.store.tableStorage,
        store: deps.store,
        graphRegistry: deps.graphRegistry,
        activeWorkspace: deps.detectedScope.workspace,
    });

    // Build IAnalyticalStorage in local mode from the bundle's TABLE
    // storage. Cloud mode (DataplaneAdapter) doesn't have an analytical
    // implementation yet — registers a tool that surfaces a clear
    // "not yet wired in cloud" error. Step #6 fills this in.
    // This used to reach the graph's own collection connection while
    // collections were being written to SQLite (061e189), so every
    // aggregate threw. See engines/analyticalStorageFactory.ts.
    let analytical: IAnalyticalStorage | null = null;
    if (deps.deploymentMode === 'local') {
        analytical = createAnalyticalStorage(deps.store.tableStorage);
    }
    // Postgres-model isolation: per-workspace analytical resolver (shared
    // factory, also used by the REST dispatcher). Absent registry / cloud →
    // undefined → tools use the boot analytical built above.
    const resolveAnalytical = makeWorkspaceAnalyticalResolver(deps.graphRegistry, deps.deploymentMode);
    registerAnalyticalTools(mcpServer, { analytical, resolveAnalytical });

    registerDiagnosticTools(mcpServer, {
        store: deps.store,
        detectedScope: deps.detectedScope,
        deploymentMode: deps.deploymentMode,
        graphBasePath: deps.graphBasePath,
        nodeTypesEnum: deps.nodeTypesEnum,
        graphRegistry: deps.graphRegistry,
    });

    registerPhaseATools(mcpServer, {
        schemaLoader:        deps.schemaLoader,
        schemaAuthoring:     deps.phaseA.schemaAuthoring,
        classificationAudit: deps.phaseA.classificationAudit,
        schemaChangeAudit:   deps.phaseA.schemaChangeAudit,
        exceptionQueue:      deps.phaseA.exceptionQueue,
        syncGuard:           deps.phaseA.syncGuard,
        conflictLog:         deps.phaseA.conflictLog,
        onSchemaChanged: () => { /* schemaLoader is a fresh handle per session */ },
        // GAP 1 (2026-08-17, MCP follow-up) — same singleton + same boot
        // workspace the HTTP dispatcher wires into trySchemaRoutes
        // (dispatcher.ts's `schemaWorkspace: deps.detectedScope.workspace`),
        // so schema_approve's mandatory-HITL gate enqueues into the SAME
        // queue a human decides via POST /api/approvals/{id}/decision.
        pendingOpsStore: deps.pendingOpsStore,
        schemaWorkspace: deps.detectedScope.workspace,
        // ITEM 3 (launch-fixes-2026-08) — full run mode so the gate
        // refuses destructive schema_approve at proposal time in embedded
        // mode (see PhaseAContext.runMode).
        runMode: deps.runMode,
    });

    // Feature 1/2/4/6/7 — enterprise tools. auxStore optional.
    if (deps.auxStore) {
        registerLifecycleTools(mcpServer, { store: deps.store, auxStore: deps.auxStore, versionStore: deps.versionStore, graphRegistry: deps.graphRegistry, detectedScope: deps.detectedScope, workspaceVerbatimResolver: deps.workspaceVerbatimResolver, outboxStore: deps.outboxStore, getWal: deps.getWal });
        registerOutcomeTools(mcpServer, { store: deps.store, auxStore: deps.auxStore, versionStore: deps.versionStore, graphRegistry: deps.graphRegistry, detectedScope: deps.detectedScope });
        registerCorpusHealthTools(mcpServer, { store: deps.store, auxStore: deps.auxStore, graphRegistry: deps.graphRegistry, detectedScope: deps.detectedScope });
    }
    registerEvidenceTools(mcpServer, { store: deps.store, auditLog: deps.auditLog, graphRegistry: deps.graphRegistry, detectedScope: deps.detectedScope });
    registerAnchorTools(mcpServer, { store: deps.store, graphRegistry: deps.graphRegistry, detectedScope: deps.detectedScope });

    // Capacity management — config-driven maintain (compaction, version
    // cleanup, node retention, ephemeral-workspace expiry). Online-safe.
    registerMaintainTools(mcpServer, {
        store: deps.store,
        graphBasePath: deps.graphBasePath,
        deploymentMode: deps.deploymentMode,
        graphRegistry: deps.graphRegistry,
    });

    // Feature 8 — versioning tools. versionStore optional.
    if (deps.versionStore) {
        registerVersioningTools(mcpServer, {
            versionStore: deps.versionStore,
            store: deps.store,
            graphRegistry: deps.graphRegistry,
            detectedScope: deps.detectedScope,
            quotaStore: deps.quotaStore, // L-033 (R-005) — commit_changeset shares the write quota.
            getWorkspaceEntryForQuota: deps.getWorkspaceEntryForQuota, // L-033 (R-005).
            // 1.M7 — changeset commit/rollback orchestration (outbox +
            // embed queue + per-workspace verbatim tombstone).
            outboxStore: deps.outboxStore,
            embedQueue: deps.embedQueue,
            workspaceVerbatimResolver: deps.workspaceVerbatimResolver,
            // ITEM X-walnode (2026-09-03) — changeset delete WAL append.
            getWal: deps.getWal,
        });
    }

    /* ─── Q1.2 tool-provenance ─────────────────────────────── */
    // Stamp every `mcpServer.tool(…)` call above as 'core' so MCP clients
    // can tell core tools apart in tools/list. (Pre-v3.11.0, plugin tools
    // were stamped 'plugin:<name>' here as well; the plugin system was
    // removed in v3.11.0.)
    {
        const coreBag = (mcpServer as unknown as {
            _registeredTools: Record<string, { _meta?: Record<string, unknown> }>;
        })._registeredTools;
        for (const name of Object.keys(coreBag)) {
            const tool = coreBag[name];
            if (!tool) continue;
            tool._meta = { ...(tool._meta ?? {}), provenance: 'core' };
        }
    }

    // v1.1.1 (P0): now that every "real" tool has called server.tool()
    // and been captured into the registry, install the three shims.
    // Their registrations bypass the intercept (the lore_tool_ name
    // guard inside intercept() lets them through to the underlying
    // SDK). After this line, the MCP client sees only the three shims.
    if (lazyRegistry) {
        lazyRegistry.installShims(mcpServer);
        console.error(`[lazy-tool-shim] LORE_TOOL_SHIM=on — captured ${lazyRegistry.size()} tools behind 3 shims (lore_tool_list, lore_tool_schema, lore_tool_invoke)`);
    }

    return mcpServer;
}
