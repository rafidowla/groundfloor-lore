#!/usr/bin/env node
/**
 * server.ts — Unified Groundfloor Lore MCP Server.
 *
 * Purpose:
 *   Exposes the unified Kùzu knowledge graph as an MCP server.
 *   Combines institutional knowledge (decisions, conventions, bugs) and
 *   code intelligence into a single MCP tool surface.
 *
 * Architecture:
 *   Uses @modelcontextprotocol/sdk for transport (stdio or HTTP).
 *   Delegates storage to LocalGraph (Kùzu embedded graph).
 *   Each tool maps to one or more graph operations.
 *
 * Transport:
 *   Default: stdio (stdin/stdout) — one IDE spawns one process.
 *   --http:  Streamable HTTP daemon on port 3847 — multiple IDEs share one process.
 *   The HTTP mode solves Kùzu's single-writer file lock constraint.
 *
 * Error Behavior: Returns MCP error responses; does not crash the server.
 * Side Effects: Reads/writes .lore/graph/ via LocalGraph.
 * Determinism: Non-deterministic (depends on database state).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalGraph, type LoreNode } from '../engines/localGraph.js';
import { DataplaneGraph } from '../engines/dataplaneGraph.js';
import { bindWorkspaceToRequest, requireCurrentTenantId } from '../security/workspaceContext.js';
// @ts-ignore - workspace-linked SDK lacks full Node16 exports declaration
import { GroundfloorClient } from 'groundfloor-ts-sdk';
import { VerbatimStore, buildVerbatimText } from '../engines/verbatimStore.js';
import { DataplaneVectorStore } from '../engines/dataplaneVectorStore.js';
import type { EmbeddingProvider, VectorProvider } from '../providers/types.js';
import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';
import { OpenAICompatEmbeddingProvider } from '../providers/openAICompatEmbeddingProvider.js';
import { FeedbackStore } from '../engines/feedbackStore.js';
import { SyncEngine, WriteAheadLog } from '../engines/syncEngine.js';
import { TsSdkAdapter } from '../engines/tsSdkAdapter.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { SchemaLoader } from '../schemas/loader.js';
import { ConfigManager, resolveDeploymentMode } from '../config/configManager.js';
import { setApiKey, getApiKey, hasApiKey, deleteApiKey } from '../config/keychain.js';
import {
    loadWorkspaces,
    renameWorkspace,
    getActiveWorkspacePath,
    getActiveWorkspaceName,
    createWorkspace,
    switchWorkspace,
    deleteWorkspace,
    kebabCase,
    getWorkspaceRetention,
    setWorkspaceRetention,
} from '../config/workspaces.js';
import { stream as llmStream, getCapability, setEmbeddedModelKeepHot, type LlmProvider } from '../providers/llmDispatch.js';
import { decide as decideExtraction, type ExtractPayload } from '../providers/extractRouter.js';
import { reconnectGraph, reconnectOneNode } from '../engines/reconnect.js';
import { readCursor, writeCursor } from '../engines/reconnectCursor.js';
import { PluginRegistry } from '../plugins/registry.js';
import {
    loadManifestFromBundle,
    isTierOneManifest,
    manifestToPlugin,
    runIngest,
    type IngestNodeWrite,
} from '../plugins/manifest/index.js';
import { ManifestHotReloader } from '../plugins/manifest/hotReload.js';
import { buildPluginWizardLlmPrompt, extractFirstJsonObject } from '../plugins/manifest/llmRefine.js';
import { lockDownDataDir } from '../security/permissions.js';
import { ensureAuthToken, getAuthTokenPath } from '../security/authToken.js';
import { validateRequest, writeAuthFailure } from '../security/httpAuth.js';
import {
    assertPathAllowed,
    loadExtraIngestionRoots,
    PathAllowlistError,
} from '../security/pathAllowlist.js';
import { RateLimiter, classifyRequest } from '../security/rateLimit.js';
import { buildDefaultRegistry, ExtractorError } from '../engines/extractors/index.js';
import { inspectAllWorkspaces, inspectDataHome, formatBytes } from '../engines/storageInspector.js';
import { writeGraphReport } from '../engines/graphReport.js';
import { exportGraphAsHtml } from '../engines/htmlExport.js';
import { RetentionSweeper } from '../engines/retentionSweep.js';
import { LocalFileSink } from '../engines/archive.js';
import { buildDefaultConnectors } from '../engines/connectors/index.js';
import { decideQuota } from '../engines/quotaManager.js';
import { redactId, redactError } from '../security/logRedact.js';
import { scrubEnv } from '../security/envScrub.js';
import { rotateStandardLogs } from '../security/logRotator.js';
import { AuditLog } from '../security/audit.js';
import { ConsentManager } from '../security/consent.js';
import { McpClientRuntime } from '../engines/mcpClient/runtime.js';
import {
    wrapUntrustedContent,
    hardenedSystemPrefix,
    buildInjectionWarning,
} from '../security/promptGuard.js';
import { loreHome, loreHomePath } from '../config/loreHome.js';
/* ─── Types ───────────────────────────────────────────────────── */

/**
 * ProjectMapping — Maps a project name to its ecosystem and workspace paths.
 */
interface ProjectMapping {
    ecosystem: string;
    paths: string[];
}

/**
 * ProjectRegistry — Workspace-to-project configuration.
 * Loaded from ~/.groundfloor/projects.json.
 */
interface ProjectRegistry {
    projects: Record<string, ProjectMapping>;
}

/**
 * ResolvedScope — Auto-detected project and ecosystem for this workspace.
 */
interface ResolvedScope {
    project: string;
    ecosystem: string;
}

/* ─── Project Auto-Detection ──────────────────────────────────── */

/**
 * loadProjectRegistry — Reads project registry from disk.
 *
 * Inputs: None (reads ~/.groundfloor/projects.json).
 * Outputs: ProjectRegistry or empty registry on error.
 * Side Effects: File read.
 * Error Behavior: Returns empty registry on file not found or parse error.
 */
function loadProjectRegistry(): ProjectRegistry {
    const registryPath = loreHomePath('projects.json');
    try {
        const rawContent = fs.readFileSync(registryPath, 'utf-8');
        return JSON.parse(rawContent) as ProjectRegistry;
    } catch {
        return { projects: {} };
    }
}

/**
 * resolveProjectScope — Detects project/ecosystem from CWD.
 *
 * Matches process.cwd() against path fragments in the registry.
 * Returns '*' if no match found.
 */
function resolveProjectScope(): ResolvedScope {
    const currentWorkingDirectory = process.cwd();
    const registry = loadProjectRegistry();

    for (const [projectName, mapping] of Object.entries(registry.projects)) {
        for (const pathFragment of mapping.paths) {
            if (currentWorkingDirectory.includes(pathFragment)) {
                return { project: projectName, ecosystem: mapping.ecosystem };
            }
        }
    }

    return { project: '*', ecosystem: '*' };
}

/**
 * resolveGraphPath — Determines where to create the .lore/ graph directory.
 *
 * Priority: 1) Git repo root, 2) CWD, 3) ~/.groundfloor/
 */
function resolveGraphPath(): string {
    // V2.1: the graph lives under the currently-active workspace.
    // On first boot, loadWorkspaces() auto-writes a "default" entry that
    // points at ~/.groundfloor — preserving V2.0 data without migration.
    // Subsequent workspaces are created under ~/.groundfloor/workspaces/{name}/.
    try {
        return getActiveWorkspacePath();
    } catch (err) {
        console.error(`[Lore MCP] Workspace resolve failed (${(err as Error).message}); falling back to ~/.groundfloor`);
        return loreHome();
    }
}

/* ─── Server Setup ────────────────────────────────────────────── */

const detectedScope = resolveProjectScope();
const graphBasePath = resolveGraphPath();

const schemaLoader = new SchemaLoader(graphBasePath);
const domainSchema = schemaLoader.get();
// nodeTypesEnum and edgeRelationsEnum are both built after
// pluginRegistry.boot() below so they can merge in each active
// plug-in's contributeNodeTypes() / contributeEdgeRelations() — keeps
// Core's enums workspace-agnostic.

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

// Q2.1 — Resolve deployment mode at module scope. Env (LORE_DEPLOYMENT_MODE)
// wins over config; default is 'local'. HTTP handlers, /api/health, and
// main()'s boot gate all read this single source of truth. The cloud-mode
// boot preflight (adapter presence) runs inside main() below, *after*
// maybeUpgradeAdapterFromKeychain() — checking here would race the
// keychain upgrade and spuriously refuse to start.
const deploymentMode: 'local' | 'cloud' = resolveDeploymentMode(bootConfig);

// Q2.2 — Mode-conditional graph factory.
//
//   local mode: embedded Kùzu LocalGraph at the active workspace path.
//   cloud mode: DataplaneGraph fronting groundfloor-ts-sdk. Every op
//               reads the current workspace via AsyncLocalStorage
//               (bindWorkspaceToRequest, set at the top of each HTTP
//               request once the X-Lore-Workspace gate has passed).
//
// The daemon's public API (the `graph` binding used throughout this
// file) stays the same shape — DataplaneGraph implements GraphProvider
// AND exposes the LocalGraph-only helpers server.ts still calls directly
// (createPluginGraphContext / getLanguageBreakdown / getTopologyOverview
// / reconfigureCache), with cloud-mode stubs for the plugin-owned ones.
// See docs/dataplane-graph-adapter.md (decision q2-2-*).
type LoreGraph = LocalGraph | DataplaneGraph;
function createGraph(): LoreGraph {
    if (deploymentMode === 'cloud') {
        // In cloud mode, the Dataplane credential is mandatory (Q2.1
        // boot gate enforces this in main()). We construct a real
        // GroundfloorClient and feed it to DataplaneGraph. The tenant
        // id for each op is resolved live from AsyncLocalStorage — a
        // singleton adapter serves all tenants concurrently.
        const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
        const apiKey = process.env['DATAPLANE_API_KEY'] ?? '';
        const orgId = process.env['DATAPLANE_ORG_ID'] ?? 'default';
        // Keychain upgrade may replace this with a keychain-sourced key
        // in main() before any request lands; here we only need a key
        // that satisfies the GroundfloorClient constructor. The
        // keychain upgrade re-runs the factory if the credential changes.
        const client = new GroundfloorClient(baseUrl, apiKey || 'pending-keychain');
        return new DataplaneGraph({
            client,
            tenantProvider: () => requireCurrentTenantId(),
            orgId,
        });
    }
    return new LocalGraph(graphBasePath, {
        cacheTtlMs,
        cacheMaxSize,
        cacheDisabled,
    });
}
let graph: LoreGraph = createGraph();

// Q2.2 slice 3 — Mode-conditional vector-store factory.
//
//   local mode: embedded LanceDB VerbatimStore at the active workspace path.
//   cloud mode: DataplaneVectorStore fronting groundfloor-ts-sdk's vector
//               extension. Embedding stays local (same Xenova pipeline);
//               only storage + similarity-search IO crosses to Dataplane.
//
// Both implement VectorProvider. Call sites that touch only the provider
// surface (store/search/delete/count/initialize/close) work uniformly.
// Two call sites still reach past VectorProvider (reconnect's getById,
// orphan reaper's listIds); those run through LocalGraph-coupled code
// paths today and stay guarded by `graph instanceof LocalGraph` — cloud
// reconnect lands in a later slice. See docs/dataplane-vector-adapter.md.
// Q2.2 slice 6a/6b/7 — single EmbeddingProvider injected into both
// vector stores. Slice 6a established the abstraction; slice 6b adds
// the remote OpenAI-compatible path so users can run hosted BGE-M3 (or
// any other model exposed by an OpenAI-compatible server: Ollama, vLLM,
// HF TEI, OpenAI itself, future Lore Cloud) without changing the
// vector stores. Slice 7 surfaces multilingual-e5-small as a
// first-class local option (same 384-d width as MiniLM, ~100 languages).
//
// Selection precedence (highest → lowest):
//   1. LORE_EMBEDDING_PROVIDER=openai_compat → remote provider
//      Requires LORE_EMBEDDING_BASE_URL, LORE_EMBEDDING_MODEL,
//      LORE_EMBEDDING_DIMENSION. LORE_EMBEDDING_API_KEY optional.
//   2. LORE_LOCAL_EMBEDDING_MODEL=<modelId> → local override
//      Optional LORE_LOCAL_EMBEDDING_DIM (defaults to 384, the width
//      of both MiniLM and e5-small). Use this to opt into
//      Xenova/multilingual-e5-small without changing code.
//   3. (default) LocalEmbeddingProvider — Xenova/all-MiniLM-L6-v2.
//
// Default left at MiniLM intentionally (slice 7 commit message): existing
// installs already have it cached + reconnected; flipping the default
// would force every operator to download a new model on first boot AND
// silently produce vectors that don't match their existing LanceDB
// rows. A future slice with proper migration tooling (modelId
// fingerprint check + automatic drop+rebuild prompt) will make
// flipping safe.
//
// The vector stores below stay untouched regardless of which branch
// fires.
async function createEmbeddingProvider(): Promise<EmbeddingProvider> {
    const providerKind = (process.env['LORE_EMBEDDING_PROVIDER'] ?? '').trim().toLowerCase();

    // 2026-04-30 — auto-detect Ollama running locally before falling back
    // to Xenova-Wasm. Ollama-on-Apple-Silicon is ~50-100x faster (Metal
    // GPU + Neural Engine) than the Wasm-CPU default. Skipped when an
    // explicit override is set or when LORE_DISABLE_AUTO_DETECT_EMBEDDER=1.
    if (!providerKind && process.env['LORE_DISABLE_AUTO_DETECT_EMBEDDER'] !== '1') {
        try {
            const { pickEmbeddingProvider } = await import('../providers/pickEmbeddingProvider.js');
            const picked = await pickEmbeddingProvider(graphBasePath);
            if (!picked.isFallback) {
                console.error(picked.banner);
                return picked.provider;
            }
            // isFallback === true means pickEmbeddingProvider already
            // ended up at LocalEmbeddingProvider; fall through to the
            // existing local path below so we don't double-print.
        } catch (err) {
            console.error(`[Lore MCP] embedder auto-detect failed (non-fatal): ${(err as Error).message}`);
        }
    }

    if (providerKind === 'openai_compat' || providerKind === 'compat' || providerKind === 'remote') {
        const baseUrl = process.env['LORE_EMBEDDING_BASE_URL'] ?? '';
        const modelId = process.env['LORE_EMBEDDING_MODEL'] ?? '';
        const dimRaw = process.env['LORE_EMBEDDING_DIMENSION'] ?? '';
        const apiKey = process.env['LORE_EMBEDDING_API_KEY'] ?? undefined;
        const dimension = Number.parseInt(dimRaw, 10);

        const missing: string[] = [];
        if (!baseUrl) missing.push('LORE_EMBEDDING_BASE_URL');
        if (!modelId) missing.push('LORE_EMBEDDING_MODEL');
        if (!Number.isInteger(dimension) || dimension <= 0) missing.push('LORE_EMBEDDING_DIMENSION');
        if (missing.length > 0) {
            throw new Error(
                `[Lore MCP] LORE_EMBEDDING_PROVIDER=${providerKind} requires: ${missing.join(', ')}`
            );
        }
        console.error(
            `[Lore MCP] Embedding provider: openai_compat (model=${modelId}, dim=${dimension}, base=${baseUrl})`
        );
        return new OpenAICompatEmbeddingProvider({ baseUrl, modelId, dimension, apiKey });
    }

    const localModelOverride = (process.env['LORE_LOCAL_EMBEDDING_MODEL'] ?? '').trim();
    const localDimRaw = (process.env['LORE_LOCAL_EMBEDDING_DIM'] ?? '').trim();
    if (localModelOverride) {
        const dim = localDimRaw ? Number.parseInt(localDimRaw, 10) : undefined;
        if (localDimRaw && (!Number.isInteger(dim) || (dim ?? 0) <= 0)) {
            throw new Error(
                `[Lore MCP] LORE_LOCAL_EMBEDDING_DIM must be a positive integer (got ${JSON.stringify(localDimRaw)})`
            );
        }
        const provider = new LocalEmbeddingProvider({ modelId: localModelOverride, ...(dim ? { dimension: dim } : {}) });
        console.error(
            `[Lore MCP] Embedding provider: local override (model=${provider.modelId}, dim=${provider.dimension})`
        );
        return provider;
    }

    const provider = new LocalEmbeddingProvider();
    console.error(
        `[Lore MCP] Embedding provider: local (model=${provider.modelId}, dim=${provider.dimension})`
    );
    return provider;
}
const embeddingProvider: EmbeddingProvider = await createEmbeddingProvider();

type LoreVectorStore = VerbatimStore | DataplaneVectorStore;
function createVectorStore(): LoreVectorStore {
    if (deploymentMode === 'cloud') {
        const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
        const apiKey = process.env['DATAPLANE_API_KEY'] ?? '';
        const orgId = process.env['DATAPLANE_ORG_ID'] ?? 'default';
        // Share the pattern with createGraph(): pending-keychain is a
        // placeholder satisfied by the same maybeUpgradeAdapterFromKeychain
        // rebuild when a keychain credential is present.
        const client = new GroundfloorClient(baseUrl, apiKey || 'pending-keychain');
        return new DataplaneVectorStore({
            client,
            tenantProvider: () => requireCurrentTenantId(),
            orgId,
            embeddingProvider,
        });
    }
    return new VerbatimStore(graphBasePath, embeddingProvider);
}
const verbatimStore: LoreVectorStore = createVectorStore();
// VectorProvider-only façade. Most server.ts call sites operate through
// this interface; the raw `verbatimStore` binding is preserved for the
// two LocalGraph-only consumers (reconnect.getById and the orphan reaper).
const verbatimProvider: VectorProvider = verbatimStore;
void verbatimProvider; // reserved for future cloud-only callers
const pluginRegistry = new PluginRegistry(configManager);

// Tier 1 (manifest-only, no TypeScript) plugins are discovered under
// `<LORE_HOME>/manifests/<bundle>/plugin.{yaml,yml,json}`. Each bundle
// directory holding a Tier 1 manifest is synthesised into an
// `ILorePlugin` via the manifest adapter and registered before
// `boot()` so collision detection sees the full active set. Bundles
// whose manifest declares a `lore.module` (i.e. a TypeScript plugin)
// are skipped — those need to be registered as built-ins instead.
//
// Discovery failures (parse / validation / IO) log a one-line warning
// and continue; one bad manifest in a sibling bundle should not
// prevent the daemon from booting.
{
    const manifestsDir = loreHomePath('manifests');
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(manifestsDir);
    } catch {
        // Directory does not exist → no Tier 1 plugins. Normal.
        entries = [];
    }
    for (const entry of entries) {
        const bundleDir = path.join(manifestsDir, entry);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(bundleDir);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) continue;
        try {
            const { manifest, filePath } = await loadManifestFromBundle(bundleDir);
            if (!isTierOneManifest(manifest)) {
                console.error(
                    `[Lore MCP] Skipping ${filePath} — has \`lore.module\`, register as a built-in plugin instead.`,
                );
                continue;
            }
            const plugin = manifestToPlugin(manifest);
            pluginRegistry.registerSyntheticPlugin(plugin);
            console.error(`[Lore MCP] Tier 1 manifest plugin registered: ${plugin.name} (${filePath})`);
        } catch (err) {
            console.error(
                `[Lore MCP] Skipping bundle ${bundleDir} — ${(err as Error).message}`,
            );
        }
    }
}

pluginRegistry.boot();
console.error(`[Lore MCP] Plugins active: ${configManager.read().plugins.join(', ') || '(none)'}`);

// Snapshot which plugin names were loaded at boot so the hot-reloader
// can distinguish "this was here all along" (don't touch) from "this
// is new this session" (hot-load).
const bootRegisteredPluginNames = pluginRegistry.activeNames();
const manifestHotReloader = new ManifestHotReloader(loreHomePath('manifests'), pluginRegistry);
manifestHotReloader.start(bootRegisteredPluginNames);

// Boundary cleanup (2026-04-27) — merge plug-in-contributed node types
// and edge relations into store_node / store_edge enums. Core ships
// only generic vocabulary (decision/convention/note ; decided_for /
// caused_by / applies_to / supersedes / related_to / depends_on);
// domain words come from active plugins via contributeNodeTypes() and
// contributeEdgeRelations(). Computed after boot, before tool reg.
const pluginNodeTypeContribs = pluginRegistry.collectNodeTypeContributions();
const mergedNodeTypes: string[] = [
    ...domainSchema.nodeTypes,
    ...pluginNodeTypeContribs.map((c) => c.type.name),
];
const nodeTypesEnum = z.enum(mergedNodeTypes as [string, ...string[]]);
const nodeTypesDescription = mergedNodeTypes.join(', ');
console.error(`[Lore MCP] Node types: ${nodeTypesDescription}`);

const pluginEdgeRelationContribs = pluginRegistry.collectEdgeRelationContributions();
const mergedEdgeRelations: string[] = [
    ...domainSchema.edgeRelations,
    ...pluginEdgeRelationContribs.map((c) => c.relation.name),
];
const edgeRelationsEnum = z.enum(mergedEdgeRelations as [string, ...string[]]);
const edgeRelationsDescription = mergedEdgeRelations.join(', ');
console.error(`[Lore MCP] Edge relations: ${edgeRelationsDescription}`);

// Q2.2 slice 4 — Attach plugin cloud-schema hooks to DataplaneGraph.
// LocalGraph doesn't need this: its schema push runs via the Kùzu-oriented
// `registerSchema` hook through pluginRegistry.registerSchemas() inside
// main(). In cloud mode the Cypher path doesn't apply, so plugins that
// want cloud parity implement the separate `registerCloudSchema` hook
// and DataplaneGraph fans them out on each tenant's first touch.
if (deploymentMode === 'cloud') {
    const cloudHooks = pluginRegistry.collectCloudSchemaHooks();
    (graph as DataplaneGraph).setPluginSchemaHooks(cloudHooks);
    if (cloudHooks.length > 0) {
        console.error(
            `[Lore MCP] Cloud plugin schemas ready: ${cloudHooks.map((h) => h.plugin).join(', ')}`,
        );
    } else {
        console.error('[Lore MCP] No plugins declared cloud schemas (plugin ops remain local-mode-only)');
    }
}

// V2.2: seed the embedded-model keep-hot flag from persisted config on
// boot. PATCH /api/config updates it at runtime (see that handler).
setEmbeddedModelKeepHot(Boolean(configManager.read().keepEmbeddedModelHot));

// Plugin schema registration runs inside main() after graph.initialize()
// — see line ~1432 in main(). Doing it there avoids racing the Kùzu
// connection open with the main() init path.
const orphanStateAtBoot = pluginRegistry.getOrphanState();
if (orphanStateAtBoot.blocking) {
    console.error(`[Lore MCP] ⚠ Orphan plugins detected: ${orphanStateAtBoot.orphans.join(', ')}. /api/* is blocked until resolved via POST /api/orphan.`);
}

/**
 * resolveSyncAdapter — Auto-detect Dataplane API keys and create a TS-SDK adapter.
 *
 * Priority (S9 — keychain preferred over env):
 *   1. OS keychain entry under account='dataplane' (checked in main())
 *   2. DATAPLANE_API_KEY env var (backward-compat; useful in CI)
 *   3. Returns null if neither present (offline mode)
 *
 * This function handles the env path. Keychain override happens in main()
 * via maybeUpgradeAdapterFromKeychain() which may rebuild adapter+syncEngine.
 *
 * Side Effects: Reads env vars.
 * Determinism: Deterministic for a given environment.
 */
function resolveSyncAdapterFromEnv(): TsSdkAdapter | null {
    const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
    const apiKey = process.env['DATAPLANE_API_KEY'];
    const tenantId = process.env['DATAPLANE_TENANT_ID'] ?? 'groundfloor_lore';
    const orgId = process.env['DATAPLANE_ORG_ID'] ?? 'default';

    if (!apiKey) return null;

    return new TsSdkAdapter({ baseUrl, apiKey, tenantId, orgId });
}

// Module-level bindings. Start from env (backward compat). main() may
// replace adapter (and rebuild syncEngine) if the OS keychain has a
// dataplane credential — preferred because it's not visible to any
// process that inherits this daemon's env.
let adapter: TsSdkAdapter | null = resolveSyncAdapterFromEnv();
// SyncEngine expects a LocalGraph (it calls markSynced() on the push
// path). In cloud mode this binding is still constructed so every
// server.ts call site compiles, but the sync path never activates
// because we force adapter=null in cloud mode (DataplaneGraph IS the
// data plane — there's no separate WAL to push). The cast is safe:
// SyncEngine only touches LocalGraph-specific methods when adapter
// is non-null. See q2-2-dataplane-graph-adapter-slice-1 decision.
let syncEngine: SyncEngine = new SyncEngine(graph as LocalGraph, loreDir, deploymentMode === 'cloud' ? null : adapter);
let wal = syncEngine.getWal();

/**
 * maybeUpgradeAdapterFromKeychain — S9 keychain preference.
 *
 * Called exactly once at main() startup. If the keychain has a
 * 'dataplane' account, its password overrides any env-sourced key, and
 * we rebuild adapter + syncEngine + wal with the fresh credential.
 *
 * Keychain fetch is best-effort — failures (keytar unavailable, empty
 * entry) leave the env-sourced adapter in place.
 */
async function maybeUpgradeAdapterFromKeychain(): Promise<'keychain' | 'env' | 'none'> {
    const keychainKey = await getApiKey('dataplane');
    if (!keychainKey) {
        return adapter ? 'env' : 'none';
    }
    const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
    const tenantId = process.env['DATAPLANE_TENANT_ID'] ?? 'groundfloor_lore';
    const orgId = process.env['DATAPLANE_ORG_ID'] ?? 'default';
    adapter = new TsSdkAdapter({ baseUrl, apiKey: keychainKey, tenantId, orgId });
    syncEngine = new SyncEngine(graph as LocalGraph, loreDir, deploymentMode === 'cloud' ? null : adapter);
    wal = syncEngine.getWal();
    // Q2.2 — In cloud mode, keychain-sourced credential also upgrades
    // the DataplaneGraph's client. Rebuild the graph binding so new
    // requests use the real key instead of the 'pending-keychain' stub.
    if (deploymentMode === 'cloud') {
        const newClient = new GroundfloorClient(baseUrl, keychainKey);
        graph = new DataplaneGraph({
            client: newClient,
            tenantProvider: () => requireCurrentTenantId(),
            orgId,
        });
        // Q2.2 slice 4 — Re-attach plugin cloud-schema hooks to the
        // rebuilt DataplaneGraph. The hooks are per-adapter state (not
        // global), so the keychain-upgraded graph would otherwise start
        // fresh with no plugin schemas. pluginRegistry is already booted
        // at this point, so collecting hooks is cheap and sync.
        (graph as DataplaneGraph).setPluginSchemaHooks(
            pluginRegistry.collectCloudSchemaHooks(),
        );
    }
    return 'keychain';
}

/**
 * Phase 4: Lightweight Dataplane health-ping.
 *
 * Invariants:
 *   - Fires exactly once at boot.
 *   - Sends NO graph contents, NO node counts, NO user data. Just
 *     "is the tenant reachable". Matches Non-Goal #4.
 *   - Honors config.telemetryOptOut. When true, we skip the ping entirely
 *     and treat dataplane as 'offline'.
 *   - Failure is non-fatal. Airplane-mode boot must succeed even when
 *     /etc/hosts points Dataplane at a black hole.
 */
type DataplaneState = 'unknown' | 'offline' | 'opted-out' | 'bound' | 'error';
let dataplaneState: DataplaneState = 'unknown';

async function fireBootHealthPing(): Promise<void> {
    try {
        const cfg = configManager.read();
        if (cfg.telemetryOptOut) {
            dataplaneState = 'opted-out';
            console.error('[Lore MCP] Dataplane ping: opted-out (config.telemetryOptOut=true)');
            return;
        }
        if (!adapter) {
            dataplaneState = 'offline';
            console.error('[Lore MCP] Dataplane ping: offline (no dataplane credential in keychain or DATAPLANE_API_KEY env)');
            return;
        }
        // Q1.1 — verify the tenant is actually reachable, not just that
        // the SDK client constructed. GroundfloorClient() is a local
        // object instantiation; it does not hit the network. We do a
        // lightweight GET /health (matches the Dataplane's unauth
        // health endpoint shipped 2026-04-22). 2-second timeout so
        // daemon boot never stalls on a slow remote.
        await adapter.connect();
        const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
            const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
                method: 'GET',
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`/health returned HTTP ${res.status}`);
            }
            dataplaneState = 'bound';
            console.error('[Lore MCP] Dataplane ping: bound');
        } finally {
            clearTimeout(timer);
        }
    } catch (err) {
        dataplaneState = 'error';
        console.error(`[Lore MCP] Dataplane ping: failed (${(err as Error).message}) — continuing offline`);
    }
}

function getDataplaneState(): DataplaneState {
    return dataplaneState;
}

/**
 * readJsonBody — Promisified JSON body reader for HTTP POST handlers.
 *
 * The legacy pattern in this file uses `req.on('data')` / `req.on('end')`
 * inline per route. New endpoints (plugin wizard, etc.) use this awaited
 * helper instead so the route bodies stay flat. Bounded at 10 MB to
 * keep a misbehaving client from exhausting daemon memory.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const MAX_BYTES = 10 * 1024 * 1024;
    return new Promise((resolve, reject) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) {
                reject(new Error(`request body exceeded ${MAX_BYTES} bytes`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve(text ? JSON.parse(text) : {});
            } catch (err) {
                reject(new Error(`invalid JSON body: ${(err as Error).message}`));
            }
        });
        req.on('error', reject);
    });
}

// Q1.1 — DO NOT fire the ping here. This module-scope call predates
// keychain-upgrade (S9) and fires before main() replaces `adapter`
// with the keychain-sourced instance, which hard-wires dataplaneState
// to 'offline' even when credentials are present. The ping is now
// fired inside main() immediately after maybeUpgradeAdapterFromKeychain
// so it observes the final adapter binding. Kept the export shape
// unchanged so stale imports continue to work.

/**
 * createMcpServer — Factory function to create and configure an McpServer instance.
 *
 * Purpose:
 *   Creates a new McpServer with all tools and resources registered.
 *   In stdio mode, called once. In HTTP mode, called per client session
 *   since McpServer binds to a single transport and cannot be reused.
 *
 * @returns Fully configured McpServer instance.
 *
 * Side Effects: None (tools operate on shared graph/syncEngine singletons).
 * Determinism: Deterministic.
 */
function createMcpServer(): McpServer {
    const mcpServer = new McpServer({
        name: 'groundfloor-lore',
        version: '1.0.0',
    });

/* ─── Tool: store_node ────────────────────────────────────────── */

mcpServer.tool(
    'store_node',
    `Create or update a knowledge node within the ${domainSchema.domain} domain`,
    {
        id: z.string().describe('Unique identifier (e.g., "baas-body-stream-fix")'),
        type: nodeTypesEnum.describe(`Node type (options: ${nodeTypesDescription})`),
        label: z.string().describe('Human-readable title'),
        content: z.string().optional().describe('Full text content'),
        tags: z.string().optional().describe('Comma-separated tags (e.g., "platform,baasclient,error-handling")'),
        metadata: z.string().optional().describe('JSON metadata (e.g., {"date":"2026-03-25","author":"team"})'),
        project: z.string().optional().describe('Project scope (auto-detected from workspace if omitted)'),
        ecosystem: z.string().optional().describe('Ecosystem scope (auto-detected from workspace if omitted)'),
        language: z.string().optional().describe('ISO 639-1 language code (e.g., "en", "es", "ja"). Optional — caller tags explicitly when known. Omit to leave unknown (treated as default / English downstream). See detect_language tool.'),
    },
    async ({ id, type, label, content, tags, metadata, project, ecosystem, language }) => {
        try {
            const scopedProject = project ?? detectedScope.project;
            const scopedEcosystem = ecosystem ?? detectedScope.ecosystem;

            const node = await graph.upsertNode({
                id,
                type,
                label,
                content: content ?? '',
                tags: tags ?? '',
                project: scopedProject,
                ecosystem: scopedEcosystem,
                metadata: metadata ?? '{}',
                language: language ?? null,
            });

            // Buffer write to WAL for async sync
            wal.append('upsert_node', { ...node });

            // Verbatim is keyed by `lore:<id>` everywhere else (reconnect,
            // delete_node tombstone, get_full lookups). Use the same
            // canonical prefix here so a single node has exactly one
            // verbatim row across the ingest, reconnect, and delete paths
            // — not two rows under raw and prefixed ids racing each other.
            verbatimStore.store({
                id: `lore:${id}`,
                text: buildVerbatimText(label, content ?? '', tags ?? ''),
                metadata: { type, label, tags: tags ?? '', project: scopedProject, ecosystem: scopedEcosystem, updatedAt: node.updatedAt }
            }).catch((err) => console.error(`[Lore MCP] VerbatimStore write failed for ${redactId(id)}: ${redactError(err)}`));

            // V2.1 ingest hook (Option A): immediately draw semantic
            // neighbor edges to this node's top-K similar neighbors. Keeps
            // the graph connected as new knowledge arrives.
            // Opt out via config.pluginConfig.developer.autoLinkOnIngest=false.
            const cfgForHook = configManager.read();
            const devCfg = (cfgForHook.pluginConfig?.developer ?? {}) as { autoLinkOnIngest?: boolean };
            if (devCfg.autoLinkOnIngest !== false) {
                // Q2.2 — reconnect is a local-only plugin-heavy op today;
                // cloud mode will get a Dataplane-native variant in a later
                // slice. Cast is safe: reconnect only runs in local mode
                // today, and cloud ingest doesn't invoke this hook path.
                // Q2.2 slice 3 — verbatimStore cast to VerbatimStore is
                // safe here because this call is already LocalGraph-only
                // (see `graph as LocalGraph` above). Cloud-mode reconnect
                // lands in a later slice.
                void reconnectOneNode(graph as LocalGraph, verbatimStore as VerbatimStore, pluginRegistry, {
                    id,
                    label,
                    content: content ?? '',
                    tags: tags ?? '',
                    type,
                    project: scopedProject,
                    ecosystem: scopedEcosystem,
                }).catch((err) => console.error(`[Lore MCP] ingest-hook reconnect failed for ${redactId(id)}: ${redactError(err)}`));
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        node: { id: node.id, type: node.type, label: node.label, project: scopedProject, ecosystem: scopedEcosystem },
                        message: `Node '${id}' stored successfully (project: ${scopedProject}, ecosystem: ${scopedEcosystem}).`,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: lore_plugin_ingest ────────────────────────────────── */
/*
 * Run the declarative ingest specs in a Tier 1 manifest plugin.
 *
 * Lookup: <LORE_HOME>/manifests/<plugin>/plugin.{yaml,yml,json}.
 * The manifest is reloaded fresh on every call (not cached at boot)
 * so the user can edit YAML and re-trigger without restarting the
 * daemon — important for iterating on a new plugin.
 *
 * Each spec's writer calls `graph.upsertNode` directly (the same
 * substrate `store_node` uses) and bypasses the auto-link reconnect
 * hook that store_node fires per node — bulk ingest reconnects are
 * a separate concern (planned: post-ingest sweep). This keeps a
 * 100k-row ingest from queuing 100k reconnect jobs.
 */
mcpServer.tool(
    'lore_plugin_ingest',
    'Run the declarative ingest specs declared in a Tier 1 manifest plugin. Reads the manifest fresh, runs each spec, returns counts + per-row errors.',
    {
        plugin: z.string().describe('The plugin name (matches the bundle directory under <LORE_HOME>/manifests/).'),
        ingestId: z.string().optional().describe('When the manifest declares multiple ingest entries, run only the one with this id. Omit to run all.'),
    },
    async ({ plugin, ingestId }) => {
        try {
            const bundleDir = path.join(loreHomePath('manifests'), plugin);
            const { manifest, filePath } = await loadManifestFromBundle(bundleDir);
            if (!isTierOneManifest(manifest)) {
                throw new Error(`plugin "${plugin}" is not a Tier 1 manifest plugin (it has \`lore.module\`); use the plugin's own ingest mechanism instead`);
            }
            const specs = manifest.lore?.ingest ?? [];
            if (specs.length === 0) {
                throw new Error(`plugin "${plugin}" declares no \`lore.ingest\` specs in ${filePath}`);
            }
            const targetSpecs = ingestId !== undefined
                ? specs.filter((s, i) => (s.id ?? String(i)) === ingestId)
                : specs;
            if (targetSpecs.length === 0) {
                throw new Error(`no ingest spec with id="${ingestId}" in plugin "${plugin}"`);
            }

            const writer = async (node: IngestNodeWrite): Promise<void> => {
                const tagsCsv = node.tags.join(',');
                const project = node.project ?? detectedScope.project;
                const ecosystem = node.ecosystem ?? detectedScope.ecosystem;
                const stored = await graph.upsertNode({
                    id: node.id,
                    type: node.type,
                    label: node.label,
                    content: node.content,
                    tags: tagsCsv,
                    project,
                    ecosystem,
                    metadata: JSON.stringify(node.metadata),
                    language: node.language ?? null,
                });
                wal.append('upsert_node', { ...stored });
                // Verbatim: same canonical-prefix convention as store_node.
                verbatimStore.store({
                    id: `lore:${node.id}`,
                    text: buildVerbatimText(node.label, node.content, tagsCsv),
                    metadata: { type: node.type, label: node.label, tags: tagsCsv, project, ecosystem, updatedAt: stored.updatedAt },
                }).catch((err) => console.error(`[Lore MCP] VerbatimStore write failed for ingest ${redactId(node.id)}: ${redactError(err)}`));
            };

            const reports: unknown[] = [];
            for (const spec of targetSpecs) {
                const r = await runIngest(spec, bundleDir, writer, {
                    credentialResolver: async (key: string) => await getApiKey(key),
                });
                reports.push({
                    ingestId: spec.id ?? null,
                    sourcePath: r.sourcePath,
                    totalRows: r.totalRows,
                    ingested: r.ingested,
                    skipped: r.skipped,
                    errors: r.errors,
                    elapsedMs: r.elapsedMs,
                });
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        plugin,
                        manifest: filePath,
                        runs: reports,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: store_edge ────────────────────────────────────────── */

mcpServer.tool(
    'store_edge',
    'Create a relationship between two knowledge nodes',
    {
        sourceId: z.string().describe('Source node ID'),
        targetId: z.string().describe('Target node ID'),
        relation: edgeRelationsEnum.describe(`Relationship type (options: ${domainSchema.edgeRelations.join(', ')})`),
        bidirectional: z.boolean().optional().describe('Create edge in both directions (default: true)'),
        // C1 — confidence tier. Defaults to 'extracted' (user-asserted fact).
        confidence: z.enum(['extracted', 'inferred', 'ambiguous']).optional().describe(
            "Confidence tier. 'extracted' = user/rule-asserted fact (default). 'inferred' = LLM or similarity-inferred. 'ambiguous' = candidate needing human review.",
        ),
        confidenceScore: z.number().min(0).max(1).optional().describe(
            'Optional numeric confidence in [0,1]. Defaults to 1.0 for extracted, or the inference score for inferred/ambiguous.',
        ),
    },
    async ({ sourceId, targetId, relation, bidirectional, confidence, confidenceScore }) => {
        try {
            const useBidirectional = bidirectional ?? true;
            const conf = confidence ?? 'extracted';
            const score = confidenceScore ?? (conf === 'extracted' ? 1.0 : 0.5);

            if (useBidirectional) {
                await graph.addBidirectionalEdge({
                    sourceId, targetId, relation,
                    confidence: conf, confidenceScore: score,
                });
            } else {
                await graph.addEdge({
                    sourceId, targetId, relation,
                    confidence: conf, confidenceScore: score,
                });
            }

            // Buffer write to WAL for async sync
            wal.append('add_edge', { sourceId, targetId, relation, confidence: conf, confidenceScore: score });

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        edge: { sourceId, targetId, relation, bidirectional: useBidirectional, confidence: conf, confidenceScore: score },
                        message: `Edge '${sourceId}' ${useBidirectional ? '↔' : '→'} '${targetId}' (${relation}, ${conf}) created.`,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: traverse ──────────────────────────────────────────── */

mcpServer.tool(
    'traverse',
    'Follow graph edges from a starting node to find all connected knowledge',
    {
        nodeId: z.string().describe('Starting node ID'),
        depth: z.number().optional().describe('Max traversal depth (default: 2, max: 5)'),
    },
    async ({ nodeId, depth }) => {
        try {
            const startNode = await graph.getNode(nodeId);
            if (!startNode) {
                return {
                    content: [{ type: 'text' as const, text: `Node '${nodeId}' not found.` }],
                    isError: true,
                };
            }

            const results = await graph.traverse(nodeId, depth ?? 2);

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        startNode: { id: startNode.id, type: startNode.type, label: startNode.label },
                        connectedNodes: results.length,
                        results: results.map((item) => ({
                            depth: item.depth,
                            relation: item.relation,
                            id: item.node.id,
                            type: item.node.type,
                            label: item.node.label,
                            content: item.node.content,
                            tags: item.node.tags,
                        })),
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: search ────────────────────────────────────────────── */

mcpServer.tool(
    'search',
    'Full-text search across all knowledge nodes',
    {
        query: z.string().describe('Search query'),
        limit: z.number().optional().describe('Max results (default: 20)'),
        queryLanguage: z.string().optional().describe('ISO 639-1 code for the query language (e.g., "es"). When provided and the corpus is mostly in a different language, the response includes a cross-language hint. Core does not auto-detect — callers tag explicitly if they want the hint.'),
    },
    async ({ query, limit, queryLanguage }) => {
        try {
            const results = await graph.search(query, limit ?? 20, detectedScope.project, detectedScope.ecosystem);
            const hint = queryLanguage ? await buildLanguageHint(queryLanguage) : null;

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        query,
                        scope: { project: detectedScope.project, ecosystem: detectedScope.ecosystem },
                        resultCount: results.length,
                        results: results.map((node) => ({
                            id: node.id, type: node.type, label: node.label,
                            content: node.content, tags: node.tags, project: node.project,
                            language: node.language ?? null,
                        })),
                        ...(hint ? { hint } : {}),
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: recall ────────────────────────────────────────────── */

mcpServer.tool(
    'recall',
    'High-level knowledge recall: searches for a topic and traverses related nodes. Defaults to a compact summary (top hits, label + 1-line snippet) so the response stays under ~2KB and AI agents do not blow their context window. Pass mode="full" for the rich JSON, or use the get_full tool to fetch one node\'s body by id.',
    {
        topic: z.string().describe('Topic to recall (e.g., "BaaSClient", "auth conventions")'),
        depth: z.number().optional().describe('Traversal depth from each search result (default: 1)'),
        queryLanguage: z.string().optional().describe('ISO 639-1 code for the query language. Same semantics as `search` — optional; adds a cross-language hint to the response when the corpus is mostly in a different language.'),
        filePaths: z.array(z.string()).optional().describe('Q1.7: file paths from the current work context (e.g. from a PostToolUse edit hook). Any deferred-* node whose stored file list overlaps these paths is auto-surfaced in the `deferred` sidecar field, even if it doesn\'t match the topic text.'),
        mode: z.enum(['summary', 'full']).optional().describe('Response shape. "summary" (default) returns top hits with label + 1-line snippet only — meant for AI agents. "full" returns the rich JSON with full node bodies — meant for the human-facing CLI.'),
        crossProject: z.boolean().optional().describe('When true, ignores the current project scope and searches every project. Each hit is tagged with its project. Use this when looking for prior work that may have happened in a sibling repo (e.g. DEF, dataplane, managrid).'),
        includeSuperseded: z.boolean().optional().describe('When true, also returns nodes that have been soft-superseded by a newer version. Default false — the typical recall flow wants the current state of knowledge, not the history. Pass true when reviewing how a decision evolved.'),
    },
    async ({ topic, depth, queryLanguage, filePaths, mode, crossProject, includeSuperseded }) => {
        try {
            const responseMode = mode ?? 'summary';
            const useCrossProject = crossProject ?? false;
            const projectScope = useCrossProject ? '*' : detectedScope.project;
            const ecosystemScope = useCrossProject ? '*' : detectedScope.ecosystem;
            const verbatimCount = await verbatimStore.count();
            let seedNodeIds: string[] = [];

            if (verbatimCount > 0) {
                const results = await verbatimStore.search(topic, 10);
                seedNodeIds = results.map(r => r.id);
            }

            let searchResults: LoreNode[] = [];

            if (verbatimCount === 0 || seedNodeIds.length === 0) {
                searchResults = await graph.search(topic, 10, projectScope, ecosystemScope);
            } else {
                for (const id of seedNodeIds) {
                    // Verbatim ids are namespaced with a prefix
                    // ("lore:<rawId>" for core LoreNodes, plugin-prefixed
                    // for plugin contributions). graph.getNode expects
                    // the raw id — strip the lore: prefix here. Plugin-
                    // prefixed ids (file:, symbol:, …) are not core-
                    // addressable; they're skipped because graph.getNode
                    // returns null for them, which matches the pre-fix
                    // behaviour for plugin nodes. The /api/node handler
                    // already does this strip; recall was missing it
                    // and silently produced empty results.
                    const stripped = id.startsWith('lore:') ? id.slice(5) : id;
                    const node = await graph.getNode(stripped);
                    if (node) searchResults.push(node);
                }
            }

            // Soft-supersession filter (2026-04-28). Drop nodes whose
            // supersededAt is non-null unless the caller explicitly asks
            // to see history. Applied to seed hits AND to traversal
            // expansions so a fresh decision's neighbours don't drag in
            // its predecessors as "related".
            if (!includeSuperseded) {
                searchResults = searchResults.filter((n) => !n.supersededAt);
            }

            // Q1.7 — deferred-Lore surfacing. Run alongside the search
            // so it fires even when the topic itself returns zero hits
            // (the PostToolUse hook often passes a filepath with no
            // conceptual topic — still surface the deferred work).
            const { findDeferredMatches } = await import('../engines/deferred.js');
            const deferredMatches = await findDeferredMatches(graph, { topic, filePaths });

            if (searchResults.length === 0) {
                const earlyHint = queryLanguage ? await buildLanguageHint(queryLanguage) : null;
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            topic,
                            scope: { project: projectScope, ecosystem: ecosystemScope },
                            crossProject: useCrossProject,
                            message: `No knowledge found for topic '${topic}'${useCrossProject ? ' (searched across all projects)' : ''}.`,
                            results: [],
                            ...(deferredMatches.length > 0 ? { deferred: deferredMatches } : {}),
                            ...(earlyHint ? { hint: earlyHint } : {}),
                        }, null, 2),
                    }],
                };
            }

            const traversalDepth = depth ?? 1;
            const allNodes = new Map<string, { node: LoreNode; source: string; depth: number }>();

            for (const node of searchResults) {
                allNodes.set(node.id, { node, source: 'search', depth: 0 });
            }

            for (const searchNode of searchResults) {
                const connected = await graph.traverse(searchNode.id, traversalDepth);
                for (const item of connected) {
                    // Same supersession filter on traversal expansions.
                    if (!includeSuperseded && item.node.supersededAt) continue;
                    if (!allNodes.has(item.node.id)) {
                        allNodes.set(item.node.id, {
                            node: item.node,
                            source: `via ${searchNode.id}`,
                            depth: item.depth,
                        });
                    }
                }
            }

            const recalledNodes = Array.from(allNodes.values())
                .sort((nodeA, nodeB) => nodeA.depth - nodeB.depth);

            // Update Hot Cache
            // Q2.2 — sessionCache is a LocalGraph-only concept; cloud
            // mode has no hot-cache equivalent yet. Skip the push if
            // running against Dataplane (slice-3 follow-up).
            if (graph instanceof LocalGraph) {
                for (const item of recalledNodes) {
                    graph.sessionCache.pushNode(item.node.id);
                }
            }

            const hint = queryLanguage ? await buildLanguageHint(queryLanguage) : null;

            // Two-tier response. Summary mode is the default — it caps
            // payload size at ~2KB so AI agents don't burn their context
            // window on a recall call. Full mode returns the rich shape
            // for human-facing CLI use, kept verbatim for back-compat.
            if (responseMode === 'summary') {
                const SUMMARY_MAX_HITS = 10;
                const SNIPPET_LEN = 120;
                const trimmedHits = recalledNodes.slice(0, SUMMARY_MAX_HITS);
                const projectsSeen = new Set<string>();
                for (const item of recalledNodes) {
                    if (item.node.project) projectsSeen.add(item.node.project);
                }
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            topic,
                            mode: 'summary',
                            searchMode: verbatimCount > 0 ? 'semantic' : 'keyword',
                            scope: { project: projectScope, ecosystem: ecosystemScope },
                            crossProject: useCrossProject,
                            totalRecalled: recalledNodes.length,
                            shown: trimmedHits.length,
                            projectsSeen: Array.from(projectsSeen),
                            hits: trimmedHits.map((item) => ({
                                id: item.node.id,
                                type: item.node.type,
                                label: item.node.label,
                                project: item.node.project,
                                tags: item.node.tags,
                                snippet: typeof item.node.content === 'string'
                                    ? (item.node.content.length > SNIPPET_LEN
                                        ? item.node.content.slice(0, SNIPPET_LEN).replace(/\s+/g, ' ').trim() + '…'
                                        : item.node.content.replace(/\s+/g, ' ').trim())
                                    : null,
                                source: item.source,
                            })),
                            tip: 'Call get_full({id}) to fetch the full body of any hit. Pass mode:"full" to recall for the rich JSON.',
                            ...(deferredMatches.length > 0 ? { deferred: deferredMatches.map(d => ({ id: d.id, label: d.label })) } : {}),
                            ...(hint ? { hint } : {}),
                        }, null, 2),
                    }],
                };
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        topic,
                        mode: 'full',
                        searchMode: verbatimCount > 0 ? 'semantic' : 'keyword',
                        scope: { project: projectScope, ecosystem: ecosystemScope },
                        crossProject: useCrossProject,
                        totalRecalled: recalledNodes.length,
                        directMatches: searchResults.length,
                        connectedMatches: recalledNodes.length - searchResults.length,
                        knowledge: recalledNodes.map((item) => ({
                            id: item.node.id, type: item.node.type, label: item.node.label,
                            content: item.node.content, tags: item.node.tags,
                            project: item.node.project, source: item.source,
                            language: item.node.language ?? null,
                        })),
                        ...(deferredMatches.length > 0 ? { deferred: deferredMatches } : {}),
                        ...(hint ? { hint } : {}),
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: lore_status ───────────────────────────────────────── */
//
// One-shot reachability check for AI agents and humans alike. Returns
// the daemon's deployment mode, the project Lore thinks the current
// CWD belongs to, the count of nodes/verbatim docs in the graph, and
// flags for each of the new "Lore actually gets used" fixes (compact
// recall, cross-project recall, get_full, the auto-recall hook).
//
// Use this from the MCP client of your IDE or from a fresh Claude
// Code session to confirm the new tools are reachable before running
// real work. Example MCP call: `mcp__groundfloor-lore__lore_status({})`.

mcpServer.tool(
    'lore_status',
    'One-shot health and capability check. Returns Lore daemon state, project scope detected for the current workspace, graph + verbatim counts, and a feature flag map confirming which Phase-1-fixes (compact recall, cross-project recall, get_full, auto-recall hook) are wired up. Call this once per session to confirm Lore is reachable.',
    {},
    async () => {
        try {
            const stats = await (graph as LocalGraph).getStats();
            const verbatimCount = await verbatimStore.count();
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        daemon: 'ok',
                        deploymentMode,
                        scope: { project: detectedScope.project, ecosystem: detectedScope.ecosystem },
                        graph: {
                            nodes: stats.nodeCount,
                            edges: stats.edgeCount,
                            verbatimDocs: verbatimCount,
                            engine: graph instanceof LocalGraph ? 'kùzu + lancedb (local)' : 'dataplane (cloud)',
                        },
                        capabilities: {
                            compactRecall: true,
                            crossProjectRecall: true,
                            getFull: true,
                            httpRecallEndpoint: '/api/recall',
                            httpGetFullEndpoint: '/api/node-full',
                            renamedTools: ['code_flow_search', 'code_full_context', 'code_impact', 'code_cypher'],
                        },
                        tip: 'Call recall({topic}) (compact mode, default) or recall({topic, crossProject:true}) for cross-repo. Use get_full({id}) to fetch one body in detail.',
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: get_full ──────────────────────────────────────────── */
//
// Two-tier companion to `recall`. Recall's default summary mode emits
// short hits to keep the AI's context window cheap; when the agent
// has narrowed in on one specific node and wants the full body, it
// calls get_full({ id }). One verb that works for any node — lore
// notes, plugin-contributed nodes, deferred items — so callers don't
// need to know what type they're fetching.
//
// Lookup is cross-project by id (ids are globally unique). The
// `lore:` prefix used inside the verbatim store is stripped here,
// matching the behavior of /api/node and the recall traversal.

mcpServer.tool(
    'get_full',
    'Fetch the full body of a single Lore node by id. Use this after `recall` (summary mode) when you have narrowed in on the one or two hits whose full content you actually need. Lookup is cross-project — ids are globally unique.',
    {
        id: z.string().describe('Node id from a prior recall/search hit (e.g. "def-storage-on-dataplane-not-surrealdb-2026-04")'),
    },
    async ({ id }) => {
        try {
            const stripped = id.startsWith('lore:') ? id.slice(5) : id;
            const node = await graph.getNode(stripped);
            if (!node) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            id,
                            found: false,
                            message: `No node found with id '${id}'. Check the id from a recall hit, or call recall again with crossProject:true if you think it lives in a sibling project.`,
                        }, null, 2),
                    }],
                    isError: true,
                };
            }
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        id: node.id,
                        found: true,
                        type: node.type,
                        label: node.label,
                        project: node.project,
                        tags: node.tags,
                        content: node.content,
                        language: node.language ?? null,
                        metadata: node.metadata ?? null,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: resolve_deferred (Q1.7) ───────────────────────────── */
//
// Closes a deferred-* Lore node by stamping metadata.resolved_at (and
// optionally metadata.resolved_by_commit). The node stays in the graph
// for historical context; subsequent `recall()` calls simply skip
// resolved items in their deferred-sidecar scan.
//
// This is the counter-side of the surfacing behavior: the point of
// Q1.7 is not just "Claude sees deferred work" but also "Claude can
// mark it done once the work lands." A human-maintained status field
// in markdown would drift; the MCP round-trip keeps the canonical
// state in Kùzu.

mcpServer.tool(
    'resolve_deferred',
    'Mark a deferred-* Lore node as resolved. Stamps metadata.resolved_at (ISO timestamp) and optionally metadata.resolved_by_commit. After resolving, `recall()` no longer auto-surfaces the node.',
    {
        id: z.string().describe('Deferred node ID (must start with "deferred-")'),
        commit: z.string().optional().describe('Optional commit SHA that resolved the deferred work'),
    },
    async ({ id, commit }) => {
        try {
            const { stampResolved } = await import('../engines/deferred.js');
            const result = await stampResolved(graph, id, commit);
            if (!result) {
                return {
                    content: [{ type: 'text' as const, text: `Deferred node '${id}' not found.` }],
                    isError: true,
                };
            }
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        id: result.node.id,
                        label: result.node.label,
                        resolved_at: result.metadata['resolved_at'],
                        resolved_by_commit: result.metadata['resolved_by_commit'] ?? null,
                        message: `Deferred node '${id}' stamped as resolved.`,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: list_plugin_ir (Q1.4) ─────────────────────────────── */
//
// Returns the declared IR (Intermediate Representation) for every
// active plugin. Mirrors GET /api/plugins/ir — exposed as an MCP tool
// so agents (Claude Code, Cursor) can introspect which plugins own
// which node/edge tables before issuing store_node / store_edge calls.

mcpServer.tool(
    'list_plugin_ir',
    'List the declared IR descriptor for every active plugin: owned node/edge tables, node/edge kinds, IR version. Use this to understand which plugin owns which vocabulary in the graph.',
    {},
    async () => {
        try {
            const entries = pluginRegistry.collectIR();
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({ plugins: entries }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: analyze_graph (Q1.5) ──────────────────────────────── */
//
// Natural-language query → analytical projection. The LLM describes
// the shape-of-data question ("how many memories by month", "contracts
// by jurisdiction"); core routes to the best-matching projection by
// intent-keyword overlap and runs it locally. Result is a tabular
// payload with declared columns, rows, and source node ids.
//
// Airplane-safe: projections are local Kùzu queries. No network I/O.
// Per-plugin opt-out and global disable honored via config toggles.
//
// When `projection_id` is supplied explicitly (fully-qualified form
// `<plugin>/<id>`), routing is skipped — the tool runs the exact
// projection asked for. Agents that want deterministic execution
// (tests, scripted dashboards) should pass `projection_id`.

mcpServer.tool(
    'analyze_graph',
    [
        'Answer shape-of-data questions (counts, group-by, time-series) against the local graph.',
        'Pass a natural-language `query` ("how many memories by month?") — core routes to the best-matching plugin projection — or pass `projection_id` (e.g. "developer/lore-nodes-by-type") to run a specific projection.',
        'Returns { columns, rows, sourceNodeIds, selectedProjection }. Airplane-safe: local queries only.',
        '',
        'Q1.6 A2UI rendering: after calling this tool, emit a render token so the canvas shows the result visually. The UI parses `{{render:<component>|<json>}}` tokens out of your reply and mounts the matching renderer in the canvas slot.',
        '- `{{render:table|{"title":"...","columns":[...],"rows":[...],"sourceNodeIds":[...],"elapsedMs":N}}}` — tabular view. Always safe.',
        '- `{{render:bar_chart|{"title":"...","columns":[...],"rows":[...],"sourceNodeIds":[...],"elapsedMs":N}}}` — horizontal bar chart. Best when there is exactly one dimension (or time) column and one measure column, and rows are <= ~50. The chart auto-picks axes from column `kind`.',
        'Pass the tool result payload through verbatim (columns, rows, sourceNodeIds, elapsedMs). Add a short natural-language summary in your reply; the render token itself is hidden from the chat transcript once parsed.',
    ].join('\n'),
    {
        query: z.string().optional().describe('Natural-language question. Intent-keyword matched against available projections.'),
        projection_id: z.string().optional().describe('Fully-qualified projection id "<plugin>/<id>". Bypasses intent routing.'),
    },
    async ({ query, projection_id }) => {
        try {
            const catalog = pluginRegistry.collectAnalyticalProjections();
            if (catalog.length === 0) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            error: 'No analytical projections available. Either the feature is disabled in Settings (`analyticalProjections.enabled`) or no active plugin exposes projections.',
                            availableProjections: [],
                        }, null, 2),
                    }],
                };
            }

            let chosenFqId: string | null = null;
            let routingScore: number | null = null;

            if (projection_id) {
                chosenFqId = projection_id;
            } else if (query) {
                // Rough-match intent routing: normalize query, count
                // keyword hits per projection, pick the highest. Ties
                // broken by plugin registration order (first match wins).
                const q = query.toLowerCase();
                let best: { fqId: string; score: number } | null = null;
                for (const entry of catalog) {
                    let score = 0;
                    for (const kw of entry.projection.intentKeywords) {
                        if (q.includes(kw.toLowerCase())) score += 1;
                    }
                    if (score > 0 && (best === null || score > best.score)) {
                        best = { fqId: entry.fqId, score };
                    }
                }
                if (best) {
                    chosenFqId = best.fqId;
                    routingScore = best.score;
                }
            }

            if (!chosenFqId) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            error: query
                                ? `No projection matched the query "${query}". Try a more specific keyword or pass projection_id directly.`
                                : 'Either `query` or `projection_id` is required.',
                            availableProjections: catalog.map((e) => ({
                                fqId: e.fqId,
                                label: e.projection.label,
                                description: e.projection.description,
                                intentKeywords: e.projection.intentKeywords,
                            })),
                        }, null, 2),
                    }],
                };
            }

            const graphCtx = graph.createPluginGraphContext();
            const result = await pluginRegistry.runAnalyticalProjection(chosenFqId, graphCtx);
            if (!result) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            error: `Projection '${chosenFqId}' not found or opted out. Available: ${catalog.map((e) => e.fqId).join(', ')}`,
                        }, null, 2),
                    }],
                };
            }

            const entry = catalog.find((e) => e.fqId === chosenFqId)!;
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        selectedProjection: {
                            fqId: chosenFqId,
                            plugin: entry.plugin,
                            label: entry.projection.label,
                            routingScore,
                        },
                        columns: result.columns,
                        rows: result.rows,
                        sourceNodeIds: result.sourceNodeIds,
                        elapsedMs: result.elapsedMs,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/**
 * buildLanguageHint — Phase B (V2.2). Given the caller's declared
 * `queryLanguage`, compare it against the corpus language breakdown.
 * Return a hint object when few/no nodes match — or null when either
 * the graph has enough matches, or the distribution is uninformative
 * (e.g. corpus is entirely untagged).
 *
 * No automatic translation here. The hint tells the caller that
 * cross-language routing might help; the chat LLM already handles
 * translation naturally during answer generation, and explicit
 * callers can translate themselves if they prefer.
 */
async function buildLanguageHint(
    queryLanguage: string,
): Promise<{ queryLanguage: string; corpusLanguageBreakdown: Record<string, number>; suggestion: string } | null> {
    try {
        const breakdown = await graph.getLanguageBreakdown();
        const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
        if (total === 0) return null;

        const untagged = breakdown['null'] ?? 0;
        const tagged = total - untagged;
        const matchingLang = breakdown[queryLanguage] ?? 0;

        // If nothing in the corpus is tagged, we have no basis to claim
        // a language mismatch — fire a "no language data" hint so the
        // caller knows why translation isn't being suggested.
        if (tagged === 0) {
            return {
                queryLanguage,
                corpusLanguageBreakdown: breakdown,
                suggestion: `No nodes in the corpus are language-tagged. Your BYOK LLM will still handle translation naturally during chat. To improve raw-search quality for "${queryLanguage}" content, tag nodes explicitly at ingest (see detect_language tool or docs/LANGUAGE_DETECTION.md).`,
            };
        }

        // Of the tagged content, how much matches the query language?
        const matchingFracOfTagged = matchingLang / tagged;
        // If the query language is well-represented among tagged nodes,
        // no hint needed.
        if (matchingFracOfTagged >= 0.1) return null;

        const suggestion = `Only ${matchingLang} of ${tagged} tagged node(s) match language="${queryLanguage}" (${untagged} untagged remain). Your BYOK LLM will translate retrieved content in its answer automatically. To improve raw-search quality for "${queryLanguage}" content, tag nodes explicitly at ingest.`;

        return {
            queryLanguage,
            corpusLanguageBreakdown: breakdown,
            suggestion,
        };
    } catch {
        return null;
    }
}

/* ─── Tool: delete_node ───────────────────────────────────────── */

mcpServer.tool(
    'delete_node',
    'Remove a knowledge node and all its relationships',
    {
        id: z.string().describe('Node ID to delete'),
    },
    async ({ id }) => {
        try {
            const deleted = await graph.deleteNode(id);
            // F2a (Phase 7a): also drop the LanceDB vector. reconnect
            // stores LoreNode verbatim records under the 'lore:' prefix
            // (see reconnect.ts PREFIX_LORE) — the pre-fix version of
            // this tool passed the raw id, which silently missed every
            // single vector. That's the root of the orphan-embedding
            // bug noted in commit 5849140. Now cleared for any
            // future delete call.
            if (deleted) {
                // Verbatim is append-only memory: the LanceDB row is
                // tombstoned (kept + marked superseded) rather than
                // erased, so the prior content stays recallable for
                // history / audit / undo. Cloud-mode (DataplaneVectorStore)
                // doesn't support tombstone yet — fall back to the legacy
                // delete path on that store.
                const store = verbatimStore as unknown as { tombstone?: (id: string, reason: string) => Promise<void> };
                const op = typeof store.tombstone === 'function'
                    ? store.tombstone(`lore:${id}`, 'graph node deleted via MCP delete_node')
                    : verbatimStore.delete(`lore:${id}`);
                op.catch((err: unknown) =>
                    console.error(`[Lore MCP] Verbatim tombstone failed for ${redactId(id)}: ${redactError(err)}`),
                );
            }
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        deleted,
                        message: deleted ? `Node '${id}' deleted.` : `Node '${id}' not found.`,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: supersede_node ────────────────────────────────────── */

mcpServer.tool(
    'supersede_node',
    'Soft-supersede an old knowledge node with a newer one. The old node stays in the graph (all edges preserved) but is hidden from default recall and faded in the network view. Use when a new decision/architecture/convention replaces an older one and you want a clear record of "this was the call before, this is the call now". Reversible via clearing the supersededAt field.',
    {
        old_id: z.string().describe('ID of the node being superseded (no longer authoritative)'),
        new_id: z.string().describe('ID of the new node that replaces it'),
        reason: z.string().optional().describe('Optional free-form note explaining why the supersession happened'),
    },
    async ({ old_id, new_id, reason }) => {
        const startedAt = Date.now();
        try {
            const localGraph = graph as LocalGraph;
            const result = await localGraph.supersedeNode(old_id, new_id, reason);
            auditLog.log({
                toolName: 'supersede_node',
                args: { old_id, new_id, reason: reason ?? null },
                result: result.ok ? 'success' : 'error',
                resultDetail: result.ok ? undefined : `${result.reason}`,
                durationMs: Date.now() - startedAt,
            });
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify(
                        result.ok
                            ? { success: true, oldId: old_id, newId: new_id, message: `Marked '${old_id}' as superseded by '${new_id}'.` }
                            : { success: false, reason: result.reason, message: `Could not supersede: ${result.reason}` },
                        null,
                        2,
                    ),
                }],
                isError: !result.ok,
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: list_nodes ────────────────────────────────────────── */

mcpServer.tool(
    'list_nodes',
    'List all knowledge nodes, optionally filtered by type or tag',
    {
        type: nodeTypesEnum.optional().describe('Filter by node type'),
        tag: z.string().optional().describe('Filter by tag'),
    },
    async ({ type, tag }) => {
        try {
            const nodes = await graph.listNodes(type, tag, detectedScope.project, detectedScope.ecosystem);
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        count: nodes.length,
                        scope: { project: detectedScope.project, ecosystem: detectedScope.ecosystem },
                        filter: { type: type ?? 'all', tag: tag ?? 'all' },
                        nodes: nodes.map((node) => ({
                            id: node.id, type: node.type, label: node.label,
                            tags: node.tags, project: node.project, updatedAt: node.updatedAt,
                        })),
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: register_project ──────────────────────────────────── */

mcpServer.tool(
    'register_project',
    'Register a new project in the Lore project registry.',
    {
        name: z.string().describe('Project name (e.g., "videosnap", "tenant-coi")'),
        ecosystem: z.string().describe('Ecosystem group (e.g., "groundfloor")'),
        paths: z.array(z.string()).describe('Workspace path fragments to match'),
    },
    async ({ name, ecosystem, paths: pathFragments }) => {
        try {
            const registryPath = loreHomePath('projects.json');
            let registry: ProjectRegistry;

            try {
                const rawContent = fs.readFileSync(registryPath, 'utf-8');
                registry = JSON.parse(rawContent) as ProjectRegistry;
            } catch {
                registry = { projects: {} };
            }

            const alreadyExists = name in registry.projects;
            registry.projects[name] = { ecosystem, paths: pathFragments };

            fs.mkdirSync(path.dirname(registryPath), { recursive: true });
            fs.writeFileSync(registryPath, JSON.stringify(registry, null, 4) + '\n', 'utf-8');

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        action: alreadyExists ? 'updated' : 'registered',
                        project: { name, ecosystem, paths: pathFragments },
                        message: `Project '${name}' ${alreadyExists ? 'updated' : 'registered'} in ecosystem '${ecosystem}'.`,
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: stats ─────────────────────────────────────────────── */

mcpServer.tool(
    'stats',
    'Get knowledge graph statistics (node count, edge count, type breakdown)',
    {},
    async () => {
        try {
            const graphStats = await graph.getStats();
            graphStats.pluginStats = await pluginRegistry.collectPluginStats(
                graph.createPluginGraphContext(),
            );
            const languageBreakdown = await graph.getLanguageBreakdown();
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        ...graphStats,
                        verbatimDocuments: await verbatimStore.count(),
                        languageBreakdown,
                        graphPath: path.join(graphBasePath, '.lore', 'graph'),
                        engine: 'kùzu + lancedb',
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: detect_language ───────────────────────────────────── */

mcpServer.tool(
    'detect_language',
    'Detect the language of a text snippet. Returns an ISO 639-1 code (e.g., "en", "es") or null when confidence is below threshold. See docs/LANGUAGE_DETECTION.md — this is an explicit capability; core never calls it automatically.',
    {
        text: z.string().describe('The text to analyze.'),
        threshold: z.number().optional().describe('Minimum confidence margin (top score minus runner-up). Default 0.03. Raise for stricter results.'),
        minLength: z.number().optional().describe('Minimum text length to attempt detection. Default 20. Shorter inputs return null.'),
    },
    async ({ text, threshold, minLength }) => {
        try {
            const { detectLanguage } = await import('../engines/language.js');
            const result = detectLanguage(text, { threshold, minLength });
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify(result, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: who_is_working — MOVED (Q1.2) ──────────────────────── */
// Registered by lore-plugin-developer (see packages/lore-plugin-developer/
// src/tools.ts). Filters by developer symbol/file vocabulary → plugin
// concern. Core no longer declares it.

/* ─── Tool: sync_status ───────────────────────────────────────── */

mcpServer.tool(
    'sync_status',
    'Get the current sync engine status — WAL pending count, last sync time, remote connectivity',
    {},
    async () => {
        try {
            const status = syncEngine.getStatus();

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        walPending: status.walPending,
                        lastSync: status.lastSync === '1970-01-01T00:00:00.000Z' ? 'never' : status.lastSync,
                        remoteConfigured: status.hasAdapter,
                        autoSyncing: status.isAutoSyncing,
                        engine: 'kùzu',
                    }, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: sync_now (Q1.1 closure) ──────────────────────────── */
//
// Manually trigger a Dataplane sync round-trip from an MCP client.
// Mirrors POST /api/sync/now. Useful for (a) agents that want to
// flush the WAL deterministically before asking a question that
// depends on fresh remote data, and (b) smoke-testing the
// Dataplane binding without shelling out to curl.
//
// `direction` defaults to 'both'. Airplane-safe: missing adapter
// or unreachable Dataplane returns a structured failure object
// rather than throwing.

mcpServer.tool(
    'sync_now',
    'Manually trigger a Dataplane sync round-trip. `direction` ∈ {push, pull, both} (default: both). Returns push/pull counts and any errors. Airplane-safe — failure returns a structured error, not an exception.',
    {
        direction: z.enum(['push', 'pull', 'both']).optional().describe('Which leg(s) to run. Default: both.'),
    },
    async ({ direction }) => {
        try {
            const dir = direction ?? 'both';
            const payload: Record<string, unknown> = {};
            if (dir === 'push' || dir === 'both') {
                const p = await syncEngine.pushPending();
                payload['push'] = p;
            }
            if (dir === 'pull' || dir === 'both') {
                const p = await syncEngine.pullRemote();
                payload['pull'] = p;
            }
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: get_hot_context ───────────────────────────────────── */

mcpServer.tool(
    'get_hot_context',
    'Retrieve the Hot Cache: the most recently stored or accessed knowledge nodes. Use this to maintain immediate context.',
    {},
    async () => {
        try {
            // Q2.2 — sessionCache is LocalGraph-only; cloud mode has no
            // hot-cache yet (slice-3 follow-up). Return empty stub.
            if (!(graph instanceof LocalGraph)) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ recentNodes: [], note: 'hot-cache unavailable in cloud mode' }, null, 2),
                    }],
                };
            }
            const context = graph.sessionCache.getHotContext();
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify(context, null, 2),
                }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

/* ─── Tool: read_document_for_ingestion ───────────────────────── */

mcpServer.tool(
    'read_document_for_ingestion',
    'Read a raw text or markdown document from the filesystem so that the AI can chunk it and ingest it into the knowledge graph.',
    {
        filePath: z.string().describe('Absolute path to the document'),
    },
    async ({ filePath }) => {
        // C5.5 — enforce per-workspace quota before doing any work.
        // Red tier means ingestion is paused; we return a user-facing
        // error the caller (LLM or CLI) can surface. Soft tiers are
        // advisory for now — throttling hookup lives with the larger
        // bulk-ingestion path, not single-file reads.
        try {
            const ws = getActiveWorkspacePath();
            const breakdown = inspectDataHome(ws);
            const q = decideQuota({ breakdown });
            if (!q.allowIngestion) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Ingestion paused by quota (${q.state}, ${formatBytes(q.usedBytes)}/${formatBytes(q.budgetBytes)}). ${q.message}`,
                    }],
                    isError: true,
                };
            }
        } catch {
            // If the inspector fails (e.g. workspace path missing), fail
            // open — better to let the user ingest than to block on a
            // telemetry-style failure.
        }

        // S4 — enforce the ingestion allowlist before any disk read.
        // Rejects ~/.ssh/id_rsa, ~/.aws/credentials, ~/.groundfloor/auth.
        // token, macOS keychain files, and anything not under an explicitly
        // allowed root. See packages/lore/src/security/pathAllowlist.ts
        // for the full policy.
        let resolvedPath: string;
        try {
            resolvedPath = assertPathAllowed(filePath, {
                workspaceRoot: graphBasePath,
                extraRoots: loadExtraIngestionRoots(loreHome()),
            });
        } catch (err) {
            if (err instanceof PathAllowlistError) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Ingestion denied (${err.code}): ${err.message}`,
                    }],
                    isError: true,
                };
            }
            throw err;
        }

        // C3 (Phase 2) — route through the extractor registry based on
        // the file extension. Previously this tool only handled UTF-8
        // text; PDF/DOCX/EML now come through transparently. Binary
        // reads are intentional: the registry expects bytes, not a
        // decoded string (PDF would be corrupt after a utf-8 round-trip).
        try {
            const buf = fs.readFileSync(resolvedPath);
            const mimeType =
                extractorRegistry.mimeFromPath(resolvedPath) ?? 'text/plain';
            const extracted = await extractorRegistry.extract(buf, mimeType);
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        filePath: resolvedPath,
                        mimeType: extracted.mimeType,
                        sourceBytes: extracted.sourceBytes,
                        extractorConfidence: extracted.confidence,
                        metadata: extracted.metadata,
                        content: extracted.text,
                        instructions:
                            'Parse this extracted content into LoreNode objects. For each distinct item, ' +
                            'call store_node. When the content is an email, preserve sender/recipient in ' +
                            'the node tags and create Person-typed neighbors where appropriate. ' +
                            'When metadata.textBearing is false (image-only PDF), note that OCR is ' +
                            'required to recover content.',
                    }, null, 2),
                }],
            };
        } catch (error) {
            if (error instanceof ExtractorError) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Extraction failed (${error.code}): ${error.message}`,
                    }],
                    isError: true,
                };
            }
            return {
                content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
                isError: true,
            };
        }
    },
);

// V2.1 cleanup (Option C): the 10 developer-specific MCP tools have
// moved into src/plugins/developer/tools.ts and register themselves via
// ILorePlugin.registerTools. Core server has no knowledge of them.
// pluginRegistry.registerTools(mcpServer, pluginCtx) runs at the end
// of this factory function.


/* ─── Q1.2 tool-provenance: tag all core tools before plugins run ─── */
// Every `mcpServer.tool(…)` call above registers a core tool. Stamp
// them with `_meta: { provenance: 'core' }` so MCP clients (Claude
// Code, Cursor, etc.) can tell core tools apart from plugin-owned
// ones in the `tools/list` response. Plugin tools get
// `provenance: 'plugin:<name>'` inside pluginRegistry.registerTools
// below. Deactivating a plugin in .lore/config.json drops its tools
// out of tools/list because registerTools is never called for it.
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

/* ─── Plugin tool + resource registration ───────────────────── */

// Each active plugin registers its own MCP tools AND resources against
// this server via ILorePlugin.registerTools. Core has no knowledge of
// plugin-specific surfaces.
pluginRegistry.registerTools(mcpServer, {
    graph,
    verbatimStore,
    syncEngine,
    syncAdapter: adapter,
    schemaLoader,
    scope: detectedScope,
    loreDir,
});

    return mcpServer;
}

/* ─── Server Start ────────────────────────────────────────────── */

/** Default port for HTTP daemon mode. Override with LORE_PORT env var. */
const LORE_HTTP_PORT = parseInt(process.env['LORE_PORT'] ?? '3847', 10);

/**
 * S3 — localhost auth token. Populated at the top of main() from
 * ~/.groundfloor/auth.token (generated if missing). Consumed by the
 * HTTP request validator on every /api/* request.
 *
 * Module-level mutable: set once at boot, read on every request. Never
 * reassigned after boot; the daemon is restarted to rotate.
 */
let authToken = '';

/**
 * S5 — rate limiter shared across all /api/* handlers. Per-endpoint-class
 * token buckets; see src/security/rateLimit.ts for the defaults.
 */
const rateLimiter = new RateLimiter();

/**
 * C3 (Phase 2) — extractor registry. Built once at module load with the
 * shipped defaults (text/markdown, PDF, DOCX, EML). Plugins that want
 * to contribute additional extractors can do so before ingestion —
 * hook not yet exposed on ILorePlugin; will land when a real third-
 * party format shows up.
 */
const extractorRegistry = buildDefaultRegistry();

/**
 * C5 (Phase 2) — connector registry. Ships with FilesystemConnector.
 * Future connectors (Gmail, Drive, Slack, ...) plug in by registering
 * IConnector instances on this object. See src/engines/connectors/.
 */
const connectorRegistry = buildDefaultConnectors(extractorRegistry, graphBasePath);

/**
 * C6 (Phase 4) — audit log + consent manager. Every tool call flagged
 * requiresApproval pauses here; all destructive tool calls append an
 * audit entry regardless of approval path. See src/security/audit.ts
 * and src/security/consent.ts.
 */
const auditLog = new AuditLog();
// V2.2: thumbs-up/down feedback store. Append-only JSONL at
// ~/.groundfloor/feedback.jsonl. See engines/feedbackStore.ts.
const feedbackStore = new FeedbackStore();
const consentManager = new ConsentManager();

/**
 * Phase 6 — retention sweep + archive sink. Archive sink lives here
 * (not lazily) so it's ready when the scheduled sweep fires.
 */
const archiveSink = new LocalFileSink();
// Q2.2 — retention sweeper is LocalGraph-aware today; cloud-mode
// retention is a separate slice-3 path (Dataplane-native sweep).
// Cast is safe: in cloud mode the sweeper is instantiated but its
// scheduled sweep is a no-op against Dataplane (slice-3 follow-up).
const retentionSweeper = new RetentionSweeper(graph as LocalGraph, pluginRegistry, auditLog);

// Supersession-candidates cache (10 min TTL). Scan is embed-heavy
// (30-60s on ~150 nodes) so we cache results and let the UI bust the
// cache after a successful supersede via ?fresh=true.
const supersessionCandidatesCache = new Map<string, { payload: unknown; savedAt: number }>();

/**
 * runRetentionSweep — Walk every superseded node in the active workspace.
 * For each one whose supersededAt is older than the configured threshold,
 * tombstone its verbatim row (preserves content + history; just makes it
 * non-retrievable via default search). The graph node is left alone so
 * lineage queries still work.
 *
 * Returns counts so the caller (UI button or daily timer) can report.
 * Skips silently when autoArchiveSupersededAfterDays is null/0/<0.
 */
async function runRetentionSweep(dryRun: boolean): Promise<{
    policy: { autoArchiveSupersededAfterDays: number | null };
    eligible: number;
    archived: number;
    sample: Array<{ id: string; supersededAt: string }>;
    dryRun: boolean;
}> {
    const policy = getWorkspaceRetention(getActiveWorkspaceName());
    const threshold = policy.autoArchiveSupersededAfterDays ?? 0;
    if (threshold <= 0) {
        return { policy: { autoArchiveSupersededAfterDays: null }, eligible: 0, archived: 0, sample: [], dryRun };
    }
    const cutoff = Date.now() - threshold * 24 * 60 * 60 * 1000;
    const localGraph = graph as LocalGraph;
    const all = await localGraph.listNodes();
    const eligible = all.filter((n) => {
        if (!n.supersededAt) return false;
        const t = Date.parse(n.supersededAt);
        return Number.isFinite(t) && t < cutoff;
    });
    const sample = eligible.slice(0, 10).map((n) => ({ id: n.id, supersededAt: n.supersededAt ?? '' }));
    let archived = 0;
    if (!dryRun) {
        const store = verbatimStore as unknown as { tombstone?: (id: string, reason: string) => Promise<void> };
        if (typeof store.tombstone === 'function') {
            for (const n of eligible) {
                await store.tombstone(`lore:${n.id}`, `auto-archived per workspace policy (>${threshold}d superseded)`);
                archived++;
            }
        }
        auditLog.log({
            toolName: 'workspace.retention.sweep',
            args: { threshold, eligible: eligible.length },
            result: 'success',
            resultDetail: `archived=${archived}`,
            durationMs: 0,
        });
    }
    return {
        policy: { autoArchiveSupersededAfterDays: threshold },
        eligible: eligible.length,
        archived,
        sample,
        dryRun,
    };
}

// Daily auto-sweep. Fires every 24h; first fire is 1 minute after boot
// so the daemon doesn't block startup on it. Idempotent — running it
// twice in the same day on the same eligible nodes is fine because
// tombstone is also idempotent (re-tombstoning is a no-op write).
setTimeout(() => {
    void runRetentionSweep(false).catch((err) => {
        console.error('[retention] daily sweep failed:', (err as Error).message);
    });
    setInterval(() => {
        void runRetentionSweep(false).catch((err) => {
            console.error('[retention] daily sweep failed:', (err as Error).message);
        });
    }, 24 * 60 * 60 * 1000);
}, 60 * 1000);

/**
 * C6b (Phase 4) — MCP client runtime. Connects outward to external
 * MCP servers configured in ~/.groundfloor/mcp-servers.json. Empty
 * config = no-op; first-run has nothing configured, which is expected.
 */
const mcpClientRuntime = new McpClientRuntime();

/** Active HTTP sessions — maps session ID to transport instance. */
const activeSessions = new Map<string, StreamableHTTPServerTransport>();

/**
 * main — Initialize graph and start MCP server.
 *
 * Purpose:
 *   Supports two transport modes:
 *   - stdio (default): each IDE spawns its own process.
 *   - HTTP (--http flag): single daemon, multiple IDEs connect via HTTP.
 *
 * Inputs:
 *   - process.argv: checks for '--http' flag.
 *   - LORE_PORT env var: HTTP port (default 3847).
 *
 * Side Effects: Opens Kùzu database, starts listener (stdio or HTTP).
 * Error Behavior: Exits process with code 1 on fatal startup error.
 * Concurrency: HTTP mode creates per-session McpServer+transport pairs,
 *   all sharing a single Kùzu graph instance.
 */
async function main(): Promise<void> {
    // S9 — Parent environment scrub. Module-level env reads (DATAPLANE_*,
    // LORE_PORT) already captured whatever they needed from the inherited
    // env during import. After this call, process.env contains only the
    // allowlist — any subsequent env read inside Lore (or a plugin) can't
    // surface an AWS/GitHub/etc. token the IDE happened to have set.
    try {
        const scrub = scrubEnv();
        if (scrub.droppedCount > 0) {
            console.error(`[Lore MCP] Env scrub: dropped ${scrub.droppedCount} var(s); kept ${scrub.kept.length}. Sample dropped (non-secret names): ${scrub.droppedSamples.join(', ') || '(all names contained secret-like tokens; none safe to log)'}`);
        }
    } catch (scrubErr) {
        console.error(`[Lore MCP] Env scrub failed (non-fatal): ${(scrubErr as Error).message}`);
    }

    // S1 — File permission lockdown (Phase 0 security hardening).
    // Tighten ~/.groundfloor (data home) AND the active workspace root if
    // it differs (custom workspace paths can live anywhere). Must run
    // before graph.initialize() so Kùzu files inherit the 0700 parent dir.
    try {
        const dataHome = loreHome();
        const lockedPaths = new Set<string>([dataHome]);
        if (graphBasePath !== dataHome) lockedPaths.add(graphBasePath);
        for (const root of lockedPaths) {
            const summary = lockDownDataDir(root);
            const touched = summary.directoriesFixed + summary.filesFixed;
            if (touched > 0 || summary.errors.length > 0) {
                console.error(
                    `[Lore MCP] Perm lockdown ${root}: dirs=${summary.directoriesFixed} files=${summary.filesFixed} skipped=${summary.skipped} errors=${summary.errors.length}`,
                );
                for (const err of summary.errors) console.error(`[Lore MCP]   ${err}`);
            }
        }
    } catch (lockErr) {
        console.error(`[Lore MCP] Perm lockdown failed (non-fatal): ${(lockErr as Error).message}`);
    }

    // C6b — connect to configured external MCP servers. Fire-and-forget
    // so a slow stdio spawn doesn't block daemon boot.
    void mcpClientRuntime.connectAll().then((summary) => {
        if (summary.attempted > 0) {
            console.error(`[Lore MCP] External MCP clients: ${summary.connected}/${summary.attempted} connected (${summary.errored} errored)`);
        }
    }).catch((err) => {
        console.error(`[Lore MCP] MCP client runtime init failed: ${(err as Error).message}`);
    });

    // S9 — upgrade Dataplane adapter from keychain if available. Env
    // remains the backward-compat fallback. Rebuilds syncEngine + wal
    // on upgrade so all downstream code sees the fresh adapter.
    try {
        const source = await maybeUpgradeAdapterFromKeychain();
        if (source === 'keychain') {
            console.error('[Lore MCP] Dataplane credential: keychain');
        } else if (source === 'env') {
            console.error('[Lore MCP] Dataplane credential: env (consider moving to keychain)');
        }
    } catch (kcErr) {
        console.error(`[Lore MCP] Keychain upgrade failed (non-fatal): ${(kcErr as Error).message}`);
    }

    // Q2.1 — Server mode preflight. Runs AFTER the keychain upgrade so
    // the adapter binding has settled. Cloud mode MUST have a Dataplane
    // adapter (keychain 'dataplane' account or DATAPLANE_API_KEY env);
    // storage adapters land in Q2.2 but the deployment target itself
    // makes no sense without a cloud data layer, so refuse to boot
    // rather than silently falling back to local-only Kùzu reads.
    // Local mode just logs the effective mode for visibility.
    console.error(`[Lore MCP] Deployment mode: ${deploymentMode}`);
    if (deploymentMode === 'cloud' && !adapter) {
        console.error(
            '[Lore MCP] FATAL — cloud mode requires a Dataplane credential. ' +
            "Set one via `security add-generic-password -a dataplane -s groundfloor-lore -w <token> -U` " +
            'or DATAPLANE_API_KEY env. To run without Dataplane, unset ' +
            "LORE_DEPLOYMENT_MODE (or set it to 'local').",
        );
        process.exit(78); // EX_CONFIG — config is valid but insufficient
    }

    // Q1.1 — Dataplane runtime binding. Fire the boot health-ping AFTER
    // the adapter has been resolved (env → keychain upgrade). Fire-and-
    // forget; daemon boot must not block on network I/O. On success:
    // dataplaneState flips 'unknown' → 'bound' and /api/health surfaces
    // it. Airplane-mode: ping fails silently and state stays 'offline'
    // (no adapter) or 'error' (adapter present but connect failed).
    void fireBootHealthPing();

    // F3 (Phase 7a) — rotate standard logs if they've exceeded size
    // or age thresholds. Runs AFTER S1 lockdown (perms are already
    // tight) but BEFORE any daemon-initiated logging gets serious
    // volume for this session. Non-fatal — rotation failures log to
    // stderr and daemon proceeds.
    try {
        const _dataHomeForRotation = loreHome();
        const results = rotateStandardLogs(_dataHomeForRotation);
        for (const r of results) {
            if (r.result.rotated) {
                console.error(
                    `[Lore MCP] Rotated ${path.basename(r.path)}: ` +
                    `${r.result.beforeBytes} bytes → ${r.result.rotatedTo} ` +
                    `(${r.result.reason}; retained ${r.result.retained}, deleted ${r.result.deleted})`,
                );
            }
        }
    } catch (rotErr) {
        console.error(`[Lore MCP] Log rotation failed (non-fatal): ${(rotErr as Error).message}`);
    }

    // S3 — ensure the localhost auth token exists. Written with 0600.
    // After this line, every /api/* handler (except the public allowlist)
    // requires Authorization: Bearer <token>. UI bootstraps via
    // /api/auth/bootstrap (Host+Origin gated).
    const dataHome = loreHome();
    authToken = ensureAuthToken(dataHome);
    console.error(`[Lore MCP] Auth token at ${getAuthTokenPath(dataHome)} (0600)`);

    await graph.initialize();

    // V2.1 / Option C: each active plugin registers its own Kùzu schema
    // (e.g. developer plugin's CodeFile/CodeSymbol tables) and attaches
    // its typed api surface. Core never touches plugin-specific tables.
    try {
        await pluginRegistry.registerSchemas(graph.createPluginGraphContext());
        for (const plugin of pluginRegistry.active()) {
            console.error(`[Lore MCP] Plugin schema ready: ${plugin.name}`);
        }
    } catch (schemaErr) {
        console.error(`[Lore MCP] Plugin schema registration failed: ${(schemaErr as Error).message}`);
    }

    await verbatimStore.initialize();

    // Phase boundary fix (2026-04-27) — fire bindRuntime on plugins so
    // they have access to PluginContext (verbatimStore, syncEngine, etc.)
    // BEFORE the HTTP server starts. createMcpServer's registerTools call
    // only fires per-MCP-session in HTTP mode, which is too late for
    // daemon-level HTTP routes (e.g. /api/code-similar) that call into
    // plugin APIs directly.
    pluginRegistry.bindRuntime({
        graph,
        verbatimStore,
        syncEngine,
        syncAdapter: adapter,
        schemaLoader,
        scope: detectedScope,
        loreDir,
    });

    // Attempt Dataplane connection if adapter is configured
    if (adapter) {
        try {
            await adapter.connect();
            console.error(`[Lore MCP] Sync: ONLINE — connected to Dataplane`);
        } catch (syncConnError) {
            console.error(`[Lore MCP] Sync: OFFLINE — Dataplane unreachable (${(syncConnError as Error).message})`);
        }
    } else {
        console.error(`[Lore MCP] Sync: OFFLINE — no Dataplane credentials configured`);
    }

    const useHttp = process.argv.includes('--http');

    if (useHttp) {
        // HTTP daemon mode — per-session McpServer+transport pairs
        const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            // Historical handlers stored `req.url` in `url` and did both
            // route matching and query-param parsing off it. Strict-equality
            // matches (previously `url === '/api/topology'`) silently 404 when the
            // caller passes query params — caught in Phase 3 when the UI
            // started sending `/api/topology?limit=10000`.
            // Fix: keep `url` as the raw request URL so existing
            // `new URL(url, 'http://localhost').searchParams` calls still
            // work, and add a dedicated `pathname` for strict route matches.
            const url = req.url ?? '';
            const pathname = url.split('?', 1)[0];

            // ── S3: first gate — Host + Origin + Bearer token validation ──
            // Rejects DNS-rebinding attempts (bad Host), cross-origin browser
            // attacks (bad Origin), and unauthorized callers (missing/bad
            // Bearer). Public paths (/health, /api/health, /api/auth/
            // bootstrap) skip the bearer check but still must pass Host and
            // Origin. See packages/lore/src/security/httpAuth.ts.
            const authCheck = validateRequest(req, { port: LORE_HTTP_PORT, token: authToken });
            if (!authCheck.ok) {
                writeAuthFailure(res, authCheck);
                return;
            }

            // ── S5: rate limiting ──
            // After auth, debit a token from the matching bucket. Liveness
            // paths (health, bootstrap) are exempt. Exhausted bucket → 429
            // with a Retry-After hint. See src/security/rateLimit.ts for
            // the per-class limits.
            const bucket = classifyRequest(url, req.method ?? 'GET');
            if (bucket) {
                const r = rateLimiter.tryConsume(bucket);
                if (!r.allowed) {
                    res.writeHead(429, {
                        'Content-Type': 'application/json',
                        'Retry-After': String(r.retryAfterSec),
                    });
                    res.end(JSON.stringify({
                        error: 'rate limited',
                        bucket,
                        retryAfterSec: r.retryAfterSec,
                    }));
                    return;
                }
            }

            // Bootstrap endpoint — the UI calls this once on load to fetch
            // the auth token, then attaches it as Authorization: Bearer on
            // every subsequent /api/* request. Safe because: (a) validate
            // Request already enforced Host + Origin must be localhost, so
            // a hostile cross-origin tab can't reach here; (b) UI is always
            // same-origin on the daemon's port in production, or served
            // from localhost:5173 in dev (also allowed Origin).
            if (pathname === '/api/auth/bootstrap' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ token: authToken }));
                return;
            }

            // Q2.1 — Cloud-mode multi-tenancy contract. Every /api/*
            // request must identify its tenant workspace via the
            // `X-Lore-Workspace` header. Q2.1 validates presence only
            // (shape = non-empty string); actual per-workspace graph
            // routing lands in Q2.2 when the cloud storage adapters
            // (Arango/Qdrant/Postgres) ship. Exemptions mirror the
            // orphan-gate exemptions so the UI can still bootstrap,
            // check health, and resolve orphans / workspaces even
            // before the picker has chosen a tenant.
            if (deploymentMode === 'cloud' && url.startsWith('/api/')) {
                const headerExempt =
                    pathname === '/api/auth/bootstrap' ||
                    pathname === '/api/health' ||
                    pathname === '/api/orphan' ||
                    url.startsWith('/api/workspaces');
                if (!headerExempt) {
                    const wsHeader = req.headers['x-lore-workspace'];
                    const workspaceId = Array.isArray(wsHeader) ? wsHeader[0] : wsHeader;
                    if (!workspaceId || workspaceId.trim().length === 0) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            code: 'workspace_header_required',
                            message: "cloud mode requires 'X-Lore-Workspace: <workspace-id>' on /api/* requests",
                        }));
                        return;
                    }
                    // Q2.2 — Bind the workspace to this request's async
                    // chain so DataplaneGraph.tenantProvider and any
                    // downstream code can read it without threading an
                    // argument through every call. Uses enterWith
                    // (AsyncLocalStorage standard since Node 16) so the
                    // rest of this handler stays linear — no callback
                    // wrap around the giant switch below. Slice 3 may
                    // map workspaceId → tenantId via an internal registry;
                    // slice 2 treats them 1:1.
                    bindWorkspaceToRequest({ workspaceId: workspaceId.trim() });
                }
            }

            // Orphan-decision gate: when a plugin has been deactivated but the
            // user hasn't chosen Keep/Drop/Re-enable, block every /api/* path
            // except /api/health (so UI can render the modal), /api/orphan
            // (so the user can resolve it), and /api/workspaces/* (so the user
            // can escape by switching workspaces). Matches Option C in
            // docs/V2_implementation_plan.md.
            const orphanExempt =
                pathname === '/api/health' ||
                pathname === '/api/orphan' ||
                url.startsWith('/api/workspaces');
            if (url.startsWith('/api/') && !orphanExempt) {
                const orphanState = pluginRegistry.getOrphanState();
                if (orphanState.blocking) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        code: 'orphan_decision_required',
                        orphans: orphanState.orphans,
                        resolve: 'POST /api/orphan {plugin, decision: keep|drop|reenable, confirm?: "DROP"}',
                    }));
                    return;
                }
            }

            // Health check endpoint for monitoring
            if (pathname === '/health' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', version: '1.0.0', sessions: activeSessions.size }));
                return;
            }

            // MCP endpoint
            if (pathname === '/mcp') {
                const sessionId = req.headers['mcp-session-id'] as string | undefined;

                // Route to existing session if header present
                if (sessionId && activeSessions.has(sessionId)) {
                    const existingTransport = activeSessions.get(sessionId)!;
                    await existingTransport.handleRequest(req, res);
                    return;
                }

                // New session — create fresh McpServer + transport
                const sessionTransport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                });

                sessionTransport.onclose = () => {
                    const sid = sessionTransport.sessionId;
                    if (sid) {
                        activeSessions.delete(sid);
                        console.error(`[Lore MCP] Session ${sid.slice(0, 8)}... closed (${activeSessions.size} active)`);
                    }
                };

                const sessionServer = createMcpServer();
                await sessionServer.connect(sessionTransport);

                // Store session after connection (sessionId is set during handleRequest)
                await sessionTransport.handleRequest(req, res);

                const newSessionId = sessionTransport.sessionId;
                if (newSessionId) {
                    activeSessions.set(newSessionId, sessionTransport);
                    console.error(`[Lore MCP] New session ${newSessionId.slice(0, 8)}... (${activeSessions.size} active)`);
                }
                return;
            }

            // V2.1: Node detail for the UI drawer. Returns the node itself,
            // plus its immediate neighbors and the edges connecting them.
            // Consumed by the node-click drawer + "Ask about this" chat flow.
            if (pathname === '/api/node' && req.method === 'GET') {
                try {
                    const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
                    if (!id) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'id query param required' }));
                        return;
                    }
                    // Core only knows about LoreNodes. Plugin-contributed
                    // nodes (file:, symbol:) are in topology but not
                    // individually addressable here — V1 limitation, can
                    // add a pluginRegistry hook later.
                    const stripped = id.startsWith('lore:') ? id.slice(5) : id;
                    const node = await graph.getNode(stripped);
                    if (!node) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `Node "${id}" not found` }));
                        return;
                    }
                    // Pull immediate neighbors in both directions via a direct
                    // 1-hop Cypher match (simpler than traverse, which uses
                    // a recursive pattern that some kuzu-lite builds choke on).
                    const pluginCtxForNode = graph.createPluginGraphContext();
                    const outRows = await pluginCtxForNode.queryRows(
                        `MATCH (n:LoreNode {id: $id})-[e:LoreEdge]->(m:LoreNode)
                         RETURN m.id AS id, m.label AS label, m.type AS type,
                                e.relation AS rel, e.confidence AS conf, e.confidenceScore AS score`,
                        { id: stripped },
                    ).catch(() => []);
                    const inRows = await pluginCtxForNode.queryRows(
                        `MATCH (m:LoreNode)-[e:LoreEdge]->(n:LoreNode {id: $id})
                         RETURN m.id AS id, m.label AS label, m.type AS type,
                                e.relation AS rel, e.confidence AS conf, e.confidenceScore AS score`,
                        { id: stripped },
                    ).catch(() => []);
                    const neighbors = [
                        ...outRows.map((r) => ({
                            id: r.id as string,
                            label: r.label as string,
                            type: r.type as string,
                            relation: (r.rel as string) || 'related_to',
                            confidence: (r.conf as string) ?? 'extracted',
                            confidenceScore: typeof r.score === 'number' ? r.score : 1.0,
                            depth: 1,
                        })),
                        ...inRows.map((r) => ({
                            id: r.id as string,
                            label: r.label as string,
                            type: r.type as string,
                            relation: `← ${(r.rel as string) || 'related_to'}`,
                            confidence: (r.conf as string) ?? 'extracted',
                            confidenceScore: typeof r.score === 'number' ? r.score : 1.0,
                            depth: 1,
                        })),
                    ];
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ node, neighbors }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // Save / create a node from the UI dashboard
            // Compact recall over HTTP. Same shape as the MCP recall
            // tool's summary mode. Used by `lore recall` CLI and the
            // UserPromptSubmit hook so they don't have to open Kùzu
            // (which would clash with the daemon's exclusive lock).
            // GET-style with query params for trivial shell invocation.
            if (pathname === '/api/recall' && req.method === 'GET') {
                try {
                    const recallParams = new URL(url, 'http://localhost').searchParams;
                    const topic = recallParams.get('topic') ?? '';
                    if (!topic) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: '`topic` query param is required' }));
                        return;
                    }
                    const crossProject = recallParams.get('crossProject') === 'true';
                    const includeSuperseded = recallParams.get('include_superseded') === 'true'
                        || recallParams.get('includeSuperseded') === 'true';
                    const max = parseInt(recallParams.get('max') ?? '8', 10);
                    const projectScope = crossProject ? '*' : detectedScope.project;
                    const ecosystemScope = crossProject ? '*' : detectedScope.ecosystem;

                    const verbatimCount = await verbatimStore.count();
                    // Dedupe by node id — both the verbatim seed loop
                    // and the graph keyword fallback can surface the
                    // same logical node (verbatim ids carry a `lore:`
                    // prefix that strips to the same key as the graph
                    // result). Map-by-id is the simplest fix.
                    const seenIds = new Set<string>();
                    const hits: LoreNode[] = [];
                    if (verbatimCount > 0) {
                        const seeds = await verbatimStore.search(topic, max);
                        for (const seed of seeds) {
                            const stripped = seed.id.startsWith('lore:') ? seed.id.slice(5) : seed.id;
                            if (seenIds.has(stripped)) continue;
                            const n = await graph.getNode(stripped);
                            if (n) {
                                // Drop superseded nodes from default
                                // recall (mirrors the MCP recall tool's
                                // soft-supersession filter).
                                if (!includeSuperseded && n.supersededAt) continue;
                                hits.push(n);
                                seenIds.add(n.id);
                            }
                        }
                    }
                    if (hits.length === 0) {
                        const fallback = await graph.search(topic, max, projectScope, ecosystemScope);
                        for (const n of fallback) {
                            if (seenIds.has(n.id)) continue;
                            if (!includeSuperseded && n.supersededAt) continue;
                            hits.push(n);
                            seenIds.add(n.id);
                        }
                    }

                    const SNIPPET_LEN = 120;
                    const projectsSeen = new Set<string>();
                    for (const n of hits) projectsSeen.add(n.project ?? '*');

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        topic,
                        crossProject,
                        scope: { project: projectScope, ecosystem: ecosystemScope },
                        hits: hits.length,
                        projects: Array.from(projectsSeen),
                        results: hits.map((n) => ({
                            id: n.id,
                            type: n.type,
                            label: n.label,
                            project: n.project,
                            tags: n.tags,
                            snippet: typeof n.content === 'string'
                                ? (n.content.length > SNIPPET_LEN
                                    ? n.content.slice(0, SNIPPET_LEN).replace(/\s+/g, ' ').trim() + '…'
                                    : n.content.replace(/\s+/g, ' ').trim())
                                : null,
                        })),
                    }));
                } catch (recallErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (recallErr as Error).message }));
                }
                return;
            }

            // Fetch the full body of a single node by id. Companion to
            // /api/recall — the CLI's `lore get-full <id>` calls this
            // when the daemon is up so it doesn't fight Kùzu's lock.
            // Path is `/api/node-full` (not `/api/node/full`) to avoid
            // the existing `/api/node` startsWith match above, which is
            // auth-gated and returns a different shape (node + neighbors).
            // Reap orphaned verbatim rows (rows whose graph node no
            // longer exists). Same logic as the `lore verbatim reap`
            // CLI but lives in the daemon so it doesn't fight Kùzu's
            // single-writer lock. Tombstones rather than deletes —
            // verbatim is append-only memory.
            //   POST /api/verbatim/reap { apply?: boolean, prefix?: string }
            //   default prefix = "lore:" (covers the canonical Lore namespace).
            if (pathname === '/api/verbatim/reap' && req.method === 'POST') {
                try {
                    const body = await new Promise<string>((resolve) => {
                        let data = '';
                        req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        req.on('end', () => resolve(data));
                    });
                    const parsed = JSON.parse(body || '{}') as { apply?: boolean; prefix?: string };
                    const prefix = parsed.prefix ?? 'lore:';
                    const apply = parsed.apply === true;
                    const store = verbatimStore as unknown as {
                        listIds?: (p?: string) => Promise<string[]>;
                        tombstone?: (id: string, reason: string) => Promise<void>;
                    };
                    if (typeof store.listIds !== 'function' || typeof store.tombstone !== 'function') {
                        res.writeHead(501, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'reap not supported by current vector store backend' }));
                        return;
                    }
                    const allIds = await store.listIds(prefix);
                    const orphans: string[] = [];
                    let alive = 0;
                    for (const vid of allIds) {
                        // Skip history snapshots — only the canonical
                        // row presence determines whether the node has
                        // a live counterpart in the graph.
                        if (vid.includes('#rev')) continue;
                        // Derive the graph node id: always strip the
                        // canonical `lore:` prefix when present (graph
                        // nodes are stored by raw id). Plugin-prefixed
                        // ids (e.g. `symbol:`, `file:`) are not graph
                        // nodes — skip them so they aren't flagged as
                        // orphans.
                        const isLore = vid.startsWith('lore:');
                        const isPluginPrefixed = !isLore && /^[a-z_]+:/.test(vid);
                        if (isPluginPrefixed) {
                            // Plugin verbatim rows use their own id space
                            // (symbol:<uid>, file:<path>). Liveness checks
                            // for those belong to the owning plugin.
                            alive++;
                            continue;
                        }
                        const nid = isLore ? vid.slice('lore:'.length) : vid;
                        const node = await graph.getNode(nid);
                        if (node == null) orphans.push(vid);
                        else alive++;
                    }
                    let tombstoned = 0;
                    if (apply) {
                        for (const id of orphans) {
                            await store.tombstone(id, 'graph node missing — discovered via /api/verbatim/reap');
                            tombstoned++;
                        }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        prefix,
                        apply,
                        inspected: allIds.length,
                        alive,
                        orphans: orphans.length,
                        tombstoned,
                        sample: orphans.slice(0, 20),
                    }));
                } catch (reapErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (reapErr as Error).message }));
                }
                return;
            }

            // Soft-supersede a node. POST body: { oldId, newId, reason? }.
            // Mirror of the supersede_node MCP tool for HTTP / CLI clients.
            if (pathname === '/api/node/supersede' && req.method === 'POST') {
                try {
                    const body = await new Promise<string>((resolve) => {
                        let data = '';
                        req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        req.on('end', () => resolve(data));
                    });
                    const parsed = JSON.parse(body || '{}') as { oldId?: string; newId?: string; reason?: string };
                    if (!parsed.oldId || !parsed.newId) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: '`oldId` and `newId` are required in POST body' }));
                        return;
                    }
                    const localGraph = graph as LocalGraph;
                    const result = await localGraph.supersedeNode(parsed.oldId, parsed.newId, parsed.reason);
                    auditLog.log({
                        toolName: 'supersede_node',
                        args: { oldId: parsed.oldId, newId: parsed.newId, reason: parsed.reason ?? null, surface: 'http' },
                        result: result.ok ? 'success' : 'error',
                        resultDetail: result.ok ? undefined : result.reason,
                        durationMs: 0,
                    });
                    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (supErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (supErr as Error).message }));
                }
                return;
            }

            // Workspace retention policy. GET returns the current
            // policy for the active workspace; PUT updates it.
            if (pathname === '/api/workspace/retention' && req.method === 'GET') {
                try {
                    const policy = getWorkspaceRetention(getActiveWorkspaceName());
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(policy));
                } catch (rErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (rErr as Error).message }));
                }
                return;
            }

            if (pathname === '/api/workspace/retention' && req.method === 'PUT') {
                try {
                    const body = await new Promise<string>((resolve) => {
                        let data = '';
                        req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        req.on('end', () => resolve(data));
                    });
                    const patch = JSON.parse(body || '{}') as Partial<{
                        hideSupersededInRecall: boolean;
                        hideSupersededInGraph: boolean;
                        autoArchiveSupersededAfterDays: number | null;
                    }>;
                    const updated = setWorkspaceRetention(getActiveWorkspaceName(), patch);
                    auditLog.log({
                        toolName: 'workspace.retention.update',
                        args: { patch },
                        result: 'success',
                        durationMs: 0,
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(updated));
                } catch (rErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (rErr as Error).message }));
                }
                return;
            }

            // Manually run the auto-archive sweep. Useful for testing
            // policies and for "do it now" UX. POST body optional:
            // { dryRun?: boolean } — when true, returns counts without
            // actually tombstoning.
            if (pathname === '/api/workspace/retention/sweep' && req.method === 'POST') {
                try {
                    const body = await new Promise<string>((resolve) => {
                        let data = '';
                        req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        req.on('end', () => resolve(data));
                    });
                    const opts = JSON.parse(body || '{}') as { dryRun?: boolean };
                    const result = await runRetentionSweep(opts.dryRun === true);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (sErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (sErr as Error).message }));
                }
                return;
            }

            // Reverse a supersession. POST body: { id }.
            if (pathname === '/api/node/unsupersede' && req.method === 'POST') {
                try {
                    const body = await new Promise<string>((resolve) => {
                        let data = '';
                        req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        req.on('end', () => resolve(data));
                    });
                    const parsed = JSON.parse(body || '{}') as { id?: string };
                    if (!parsed.id) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: '`id` is required in POST body' }));
                        return;
                    }
                    const localGraph = graph as LocalGraph;
                    const ok = await localGraph.unsupersedeNode(parsed.id);
                    auditLog.log({
                        toolName: 'unsupersede_node',
                        args: { id: parsed.id, surface: 'http' },
                        result: ok ? 'success' : 'error',
                        resultDetail: ok ? undefined : 'not-found',
                        durationMs: 0,
                    });
                    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok }));
                } catch (unsupErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (unsupErr as Error).message }));
                }
                return;
            }

            // Manually tombstone a verbatim row. Used by admin / cleanup
            // flows that need to mark content superseded without going
            // through the graph delete_node path. POST body: { id, reason }.
            if (pathname === '/api/verbatim/tombstone' && req.method === 'POST') {
                try {
                    const body = await new Promise<string>((resolve) => {
                        let data = '';
                        req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                        req.on('end', () => resolve(data));
                    });
                    const parsed = JSON.parse(body || '{}') as { id?: string; reason?: string };
                    if (!parsed.id) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: '`id` is required in POST body' }));
                        return;
                    }
                    const store = verbatimStore as unknown as { tombstone?: (id: string, reason: string) => Promise<void> };
                    if (typeof store.tombstone !== 'function') {
                        res.writeHead(501, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'tombstone not supported by current vector store backend' }));
                        return;
                    }
                    await store.tombstone(parsed.id, parsed.reason ?? 'manual tombstone via /api/verbatim/tombstone');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, id: parsed.id }));
                } catch (tsErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (tsErr as Error).message }));
                }
                return;
            }

            // Verbatim revision history. Returns the canonical row
            // (current/tombstone) plus every prior `<id>#rev*` snapshot,
            // newest first. Used by the UI history panel and by audit
            // / "what changed and why" lookups.
            //   GET /api/verbatim/history?id=<canonicalId>
            if (pathname === '/api/verbatim/history' && req.method === 'GET') {
                try {
                    const histParams = new URL(url, 'http://localhost').searchParams;
                    const histId = histParams.get('id') ?? '';
                    if (!histId) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: '`id` query param is required (canonical verbatim id, e.g. lore:my-decision)' }));
                        return;
                    }
                    const store = verbatimStore as unknown as VerbatimStore;
                    if (typeof store.getHistory !== 'function') {
                        res.writeHead(501, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'history not supported by current vector store backend' }));
                        return;
                    }
                    const revisions = await store.getHistory(histId);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ id: histId, revisions, count: revisions.length }));
                } catch (histErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (histErr as Error).message }));
                }
                return;
            }

            // Find supersession candidates. For each non-superseded node
            // of the requested types, runs vector search of its verbatim
            // text against its siblings (same project) and returns pairs
            // above the similarity threshold. The UI presents these as
            // "did you mean to supersede X with Y?" cards.
            //   GET /api/node/supersession-candidates?project=...&minScore=0.7&fresh=true
            //
            // Result is cached for 10 min per (project, minScore) tuple
            // because the embed-heavy scan takes 30-60s on a real graph.
            // Pass `fresh=true` to bust the cache after running supersede.
            if (pathname === '/api/node/supersession-candidates' && req.method === 'GET') {
                try {
                    const cp = new URL(url, 'http://localhost').searchParams;
                    const projectFilter = cp.get('project') ?? undefined;
                    const minScore = parseFloat(cp.get('minScore') ?? '0.78');
                    const typesParam = cp.get('types') ?? 'decision,architecture,convention,bug_pattern';
                    const allowedTypes = new Set(typesParam.split(',').map((t) => t.trim()).filter(Boolean));
                    const fresh = cp.get('fresh') === 'true';

                    // 10-min in-memory cache per (project, minScore, types) tuple.
                    const cacheKey = `${projectFilter ?? '*'}::${minScore}::${typesParam}`;
                    if (!fresh) {
                        const cached = supersessionCandidatesCache.get(cacheKey);
                        if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ...(cached.payload as Record<string, unknown>), cached: true, cachedAgeMs: Date.now() - cached.savedAt }));
                            return;
                        }
                    }

                    const localGraph = graph as LocalGraph;
                    // Pull all candidate nodes (current + same project + matching types).
                    const allNodes = await localGraph.listNodes(undefined, undefined, projectFilter ?? '*');
                    const candidates = allNodes.filter((n) =>
                        allowedTypes.has(n.type)
                        && !n.supersededAt,
                    );

                    type Pair = {
                        oldId: string;
                        oldLabel: string;
                        oldContent: string;
                        oldCreatedAt: string;
                        newId: string;
                        newLabel: string;
                        newContent: string;
                        newCreatedAt: string;
                        score: number;
                        project: string;
                    };
                    const pairs: Pair[] = [];
                    const seenPairs = new Set<string>();
                    const candidateById = new Map(candidates.map((c) => [c.id, c]));

                    // Parallel batched search: 8 in flight at a time
                    // bounds memory for the embedder while still ~5x
                    // faster than sequential. Hard cap on candidates
                    // (200) keeps unscoped scans bounded.
                    const SCAN_CAP = 200;
                    const BATCH_SIZE = 8;
                    const toScan = candidates.slice(0, SCAN_CAP);
                    for (let i = 0; i < toScan.length; i += BATCH_SIZE) {
                        const batch = toScan.slice(i, i + BATCH_SIZE);
                        // Embed query = label only (much shorter than full
                        // content; gives near-identical similarity signal
                        // for decision/architecture nodes which are
                        // primarily named by their label).
                        const batchResults = await Promise.all(batch.map(async (n) => {
                            const q = (n.label ?? '').trim() || (n.content ?? '').slice(0, 200);
                            if (!q) return { node: n, hits: [] as Array<{ id: string; score: number }> };
                            try {
                                const hits = await verbatimStore.search(q, 5);
                                return { node: n, hits };
                            } catch {
                                return { node: n, hits: [] as Array<{ id: string; score: number }> };
                            }
                        }));
                        for (const { node: n, hits } of batchResults) {
                            for (const hit of hits) {
                                const stripped = hit.id.startsWith('lore:') ? hit.id.slice(5) : hit.id;
                                if (stripped === n.id) continue;
                                if (hit.score < minScore) continue;
                                const key = stripped < n.id ? `${stripped}||${n.id}` : `${n.id}||${stripped}`;
                                if (seenPairs.has(key)) continue;
                                const partner = candidateById.get(stripped);
                                if (!partner) continue;
                                const aDate = n.createdAt || '';
                                const bDate = partner.createdAt || '';
                                const isANewer = aDate > bDate;
                                const newer = isANewer ? n : partner;
                                const older = isANewer ? partner : n;
                                pairs.push({
                                    oldId: older.id,
                                    oldLabel: older.label,
                                    oldContent: (older.content ?? '').slice(0, 240),
                                    oldCreatedAt: older.createdAt ?? '',
                                    newId: newer.id,
                                    newLabel: newer.label,
                                    newContent: (newer.content ?? '').slice(0, 240),
                                    newCreatedAt: newer.createdAt ?? '',
                                    score: hit.score,
                                    project: n.project ?? '*',
                                });
                                seenPairs.add(key);
                            }
                        }
                    }

                    // Sort highest confidence first.
                    pairs.sort((a, b) => b.score - a.score);
                    const payload = {
                        scope: { project: projectFilter ?? null, minScore, types: Array.from(allowedTypes) },
                        candidatesScanned: candidates.length,
                        pairs,
                    };
                    supersessionCandidatesCache.set(cacheKey, { payload, savedAt: Date.now() });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(payload));
                } catch (cErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (cErr as Error).message }));
                }
                return;
            }

            // Soft-supersession lineage. Returns the full chain for a
            // node: every prior version (walk supersededBy backwards)
            // plus every successor (find nodes whose supersededBy points
            // here, recursively forward). Ordered oldest → newest.
            //   GET /api/node/lineage?id=<nodeId>
            if (pathname === '/api/node/lineage' && req.method === 'GET') {
                try {
                    const lp = new URL(url, 'http://localhost').searchParams;
                    const startId = lp.get('id') ?? '';
                    if (!startId) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: '`id` query param is required' }));
                        return;
                    }
                    const localGraph = graph as LocalGraph;
                    const visited = new Set<string>();
                    const stripped = startId.startsWith('lore:') ? startId.slice(5) : startId;

                    // Walk forward (this node's supersededBy chain).
                    const forward: LoreNode[] = [];
                    let cursor: string | null = stripped;
                    while (cursor && !visited.has(cursor)) {
                        visited.add(cursor);
                        const n = await localGraph.getNode(cursor);
                        if (!n) break;
                        forward.push(n);
                        cursor = n.supersededBy ?? null;
                    }

                    // Walk backward (find nodes that point to this one).
                    // O(N) per step against the full LoreNode set — fine
                    // because chains in practice are short (1-3 deep).
                    const backward: LoreNode[] = [];
                    let backCursor: string | null = stripped;
                    while (backCursor) {
                        // Find a node whose supersededBy === backCursor
                        const stmt = await localGraph['connection'].prepare(
                            `MATCH (n:LoreNode) WHERE n.supersededBy = $by RETURN n.id AS id LIMIT 1`,
                        );
                        const result = await localGraph['connection'].execute(stmt, { by: backCursor });
                        const rows = await result.getAll();
                        if (rows.length === 0) break;
                        const predId = String(rows[0].id ?? '');
                        if (!predId || visited.has(predId)) break;
                        visited.add(predId);
                        const predNode = await localGraph.getNode(predId);
                        if (!predNode) break;
                        backward.unshift(predNode); // oldest first
                        backCursor = predId;
                    }

                    // Compose: backward (oldest predecessors first) → forward (this node + its successors).
                    const chain = [...backward, ...forward];
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        startId,
                        chain: chain.map((n) => ({
                            id: n.id,
                            label: n.label,
                            type: n.type,
                            project: n.project,
                            content: n.content,
                            supersededBy: n.supersededBy ?? null,
                            supersededAt: n.supersededAt ?? null,
                            supersededReason: n.supersededReason ?? null,
                            createdAt: n.createdAt,
                            updatedAt: n.updatedAt,
                        })),
                    }));
                } catch (linErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (linErr as Error).message }));
                }
                return;
            }

            if (pathname === '/api/node-full' && req.method === 'GET') {
                try {
                    const fullParams = new URL(url, 'http://localhost').searchParams;
                    const nodeId = fullParams.get('id') ?? '';
                    if (!nodeId) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: '`id` query param is required' }));
                        return;
                    }
                    const stripped = nodeId.startsWith('lore:') ? nodeId.slice(5) : nodeId;
                    const node = await graph.getNode(stripped);
                    if (!node) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ found: false, id: nodeId }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        found: true,
                        id: node.id,
                        type: node.type,
                        label: node.label,
                        project: node.project,
                        tags: node.tags,
                        content: node.content,
                        language: node.language ?? null,
                        metadata: node.metadata ?? null,
                    }));
                } catch (getFullErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (getFullErr as Error).message }));
                }
                return;
            }

            if (pathname === '/api/node' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const nodeData = JSON.parse(body);
                        if (!nodeData.id || !nodeData.type || !nodeData.label) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'id, type, and label are required' }));
                            return;
                        }
                        const node = await graph.upsertNode(nodeData);
                        // Q2.2 slice 3 — mirror the MCP `store_node` tool's
                        // verbatim write so semantic search stays in sync
                        // regardless of ingest surface. Fire-and-forget
                        // (the HTTP response shouldn't block on embedding).
                        // Same canonical-id consolidation as the MCP
                        // store_node path: write at `lore:<id>` so all
                        // surfaces (ingest / reconnect / tombstone /
                        // recall) hit the same row.
                        verbatimStore.store({
                            id: `lore:${nodeData.id}`,
                            text: buildVerbatimText(
                                nodeData.label,
                                nodeData.content ?? '',
                                nodeData.tags ?? '',
                            ),
                            metadata: {
                                type: nodeData.type,
                                label: nodeData.label,
                                tags: nodeData.tags ?? '',
                                project: node.project,
                                ecosystem: node.ecosystem,
                                updatedAt: node.updatedAt,
                            },
                        }).catch((err) => console.error(`[Lore MCP] VerbatimStore write failed for ${redactId(nodeData.id)}: ${redactError(err)}`));
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, id: nodeData.id }));
                    } catch (saveErr) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (saveErr as Error).message }));
                    }
                });
                return;
            }

            // Phase A (V2.2) — language detection capability over HTTP.
            // Mirror of the MCP `detect_language` tool and the plugin
            // context's ctx.detectLanguage(). Explicit-only, see
            // docs/LANGUAGE_DETECTION.md.
            if (pathname === '/api/language/detect' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const payload = JSON.parse(body || '{}') as { text?: string; threshold?: number; minLength?: number };
                        if (typeof payload.text !== 'string') {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: '`text` (string) is required' }));
                            return;
                        }
                        const { detectLanguage } = await import('../engines/language.js');
                        const result = detectLanguage(payload.text, {
                            threshold: payload.threshold,
                            minLength: payload.minLength,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch (detectErr) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (detectErr as Error).message }));
                    }
                });
                return;
            }

            // Full-text content search from the UI dashboard
            if (url.startsWith('/api/search') && req.method === 'GET') {
                try {
                    const searchParams = new URL(url, 'http://localhost').searchParams;
                    const query = searchParams.get('q') ?? '';
                    const results = await graph.search(query, 50);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(results));
                } catch (searchErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (searchErr as Error).message }));
                }
                return;
            }

            // HTTP mirror of the MCP `stats` tool — same payload shape.
            // Used by the UI to render corpus-wide info in Settings
            // (e.g. the Phase A language breakdown).
            if (pathname === '/api/stats' && req.method === 'GET') {
                try {
                    const graphStats = await graph.getStats();
                    graphStats.pluginStats = await pluginRegistry.collectPluginStats(
                        graph.createPluginGraphContext(),
                    );
                    const languageBreakdown = await graph.getLanguageBreakdown();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        ...graphStats,
                        verbatimDocuments: await verbatimStore.count(),
                        languageBreakdown,
                    }));
                } catch (statsErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (statsErr as Error).message }));
                }
                return;
            }

            // UI Visualizer Data API Endpoint. Core returns LoreNode/LoreEdge;
            // active plugins contribute their own slice (e.g. developer
            // plugin emits CodeFile/CodeSymbol + cross-pillar edges) via
            // ILorePlugin.contributeTopology.
            //
            // Phase 3: hard 20k ceiling + truncation signal.
            //   - ?limit=N query param, clamped to [TOPOLOGY_MIN, TOPOLOGY_HARD_CAP]
            //   - default TOPOLOGY_DEFAULT when not provided
            //   - response carries { truncated, limit, totalCoreNodes } so the
            //     UI can render the "graph too large — use filters" banner
            //   - getStats() gives us the authoritative core count; plugin
            //     contributions are flagged truncated via the heuristic
            //     "plugin returned exactly limit" since contributeTopology
            //     does not expose a count surface
            //   - ordering: Kùzu's natural order for now; most-recent ORDER BY
            //     would touch getTopology internals and the other 4 call sites.
            //     Deferred to a follow-up when a second pass on topology
            //     sampling is warranted.
            if (pathname === '/api/topology' && req.method === 'GET') {
                try {
                    const TOPOLOGY_HARD_CAP = 20000;
                    const TOPOLOGY_MIN = 1000;
                    const TOPOLOGY_DEFAULT = 10000;
                    const urlObj = new URL(req.url ?? '/api/topology', 'http://local');
                    const rawLimit = Number(urlObj.searchParams.get('limit'));
                    const requested = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : TOPOLOGY_DEFAULT;
                    const limit = Math.min(Math.max(requested, TOPOLOGY_MIN), TOPOLOGY_HARD_CAP);

                    // 2026-04-27 multi-project: accept either
                    //   ?project=foo            (single, back-compat)
                    //   ?projects=foo,bar,baz   (multi)
                    // Both flow through to getTopology + plugin contributions
                    // as a string[].
                    const singleProject = urlObj.searchParams.get('project');
                    const multiProjects = urlObj.searchParams.get('projects');
                    let projectFilter: string[] | undefined = undefined;
                    if (multiProjects) {
                        const parts = multiProjects.split(',').map((p) => p.trim()).filter(Boolean);
                        if (parts.length > 0) projectFilter = parts;
                    } else if (singleProject) {
                        projectFilter = [singleProject];
                    }

                    // Tags filter (?tags=foo,bar) — resolves to a set of
                    // repo names via the developer plug-in. With multi-
                    // project support (2026-04-27), tag→multiple-repos
                    // now flows through cleanly via the array filter.
                    const tagsParam = urlObj.searchParams.get('tags');
                    if (tagsParam && !projectFilter) {
                        const tags = tagsParam.split(',').map((t) => t.trim()).filter(Boolean);
                        const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                        const devApi = devPlugin?.api as { reposForTags: (t: string[]) => string[] } | undefined;
                        if (devApi && tags.length > 0) {
                            const matched = devApi.reposForTags(tags);
                            if (matched.length > 0) projectFilter = matched;
                        }
                    }

                    const topology = await graph.getTopology(limit, projectFilter);
                    const stats = await graph.getStats();
                    let pluginTruncated = false;
                    const pluginCtx = graph.createPluginGraphContext();
                    for (const plugin of pluginRegistry.active()) {
                        if (typeof plugin.contributeTopology !== 'function') continue;
                        try {
                            const slice = await plugin.contributeTopology(pluginCtx, limit, projectFilter);
                            topology.nodes.push(...slice.nodes);
                            topology.edges.push(...slice.edges);
                            if (slice.nodes.length >= limit) pluginTruncated = true;
                        } catch (pluginErr) {
                            console.error(`[/api/topology] plugin "${plugin.name}" contribute failed:`, (pluginErr as Error).message);
                        }
                    }
                    const truncated = stats.nodeCount > limit || pluginTruncated;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        ...topology,
                        truncated,
                        limit,
                        totalCoreNodes: stats.nodeCount,
                    }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // Q1.9 — Semantic-zoom overview. Returns one aggregate blob
            // per project + cross-project edge bundle counts. Aggregation
            // runs on local Kùzu via graph.getTopologyOverview() — no
            // network, no plugin vocab leaked (grouping is on the opaque
            // `project` string that every LoreNode carries).
            //
            //   GET /api/topology/overview?groupBy=project
            //
            // Response:
            //   { blobs:          [{ project, nodeCount }],
            //     aggregateEdges: [{ fromProject, toProject, count }],
            //     totalNodes:     number,
            //     groupBy:        "project" }
            //
            // `groupBy` is echoed back so future group-by axes (e.g.
            // by-type, by-ecosystem) can be added without breaking the
            // frontend's parse. Only `project` is supported today.
            if (pathname === '/api/topology/overview' && req.method === 'GET') {
                try {
                    const urlObj = new URL(req.url ?? '/api/topology/overview', 'http://local');
                    const groupBy = urlObj.searchParams.get('groupBy') ?? 'project';
                    if (groupBy !== 'project') {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: `Unsupported groupBy "${groupBy}". Only "project" is supported.`,
                        }));
                        return;
                    }
                    const overview = await graph.getTopologyOverview();

                    // 2026-04-27: enrich aggregateEdges with code-symbol
                    // cross-project edges from the developer plug-in. Was:
                    // LoreNode-only edges (~50 ribbons under-reporting
                    // real coupling). Now: ribbons reflect both knowledge
                    // AND code coupling.
                    try {
                        const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                        const devApi = devPlugin?.api as { getCrossProjectCodeEdgeCounts: () => Promise<Array<{ fromProject: string; toProject: string; count: number }>> } | undefined;
                        if (devApi) {
                            const codeEdges = await devApi.getCrossProjectCodeEdgeCounts();
                            // Merge: same (from, to) pair → sum counts.
                            const merged = new Map<string, { fromProject: string; toProject: string; count: number }>();
                            for (const e of overview.aggregateEdges) {
                                merged.set(`${e.fromProject}||${e.toProject}`, { ...e });
                            }
                            for (const e of codeEdges) {
                                const k = `${e.fromProject}||${e.toProject}`;
                                const existing = merged.get(k);
                                if (existing) existing.count += e.count;
                                else merged.set(k, { ...e });
                            }
                            overview.aggregateEdges = Array.from(merged.values());
                        }
                    } catch (enrichErr) {
                        console.error('[/api/topology/overview] code-edge enrichment failed:', (enrichErr as Error).message);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ...overview, groupBy }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // GET /api/nodes — type-filtered list of LoreNode rows for the
            // shell's inspector renderers. Thin wrapper around
            // LocalGraph.listNodes; sliced client-side to the caller's
            // limit (engine has no server-side limit).
            //
            // Query params: type (required), tag (optional), limit (default 100, max 1000).
            if (pathname === '/api/nodes' && req.method === 'GET') {
                try {
                    const urlObj = new URL(req.url ?? '/api/nodes', 'http://local');
                    const type = urlObj.searchParams.get('type') ?? undefined;
                    const tag = urlObj.searchParams.get('tag') ?? undefined;
                    const limitParam = Number(urlObj.searchParams.get('limit'));
                    const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100, 1000);
                    if (!type) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'type is a required query parameter' }));
                        return;
                    }
                    const all = await (graph as LocalGraph).listNodes(type, tag);
                    const sliced = all.slice(0, limit);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ count: sliced.length, totalMatching: all.length, nodes: sliced }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // GET /api/plugins/permissions — summary of declared permissions
            // per active manifest plugin. Used by the shell at install
            // time and the Settings panel for ongoing visibility.
            if (pathname === '/api/plugins/permissions' && req.method === 'GET') {
                try {
                    const manifestsDir = loreHomePath('manifests');
                    const out: Array<{ plugin: string; lorePermissions: string[]; defPermissions: string[] }> = [];
                    let entries: string[] = [];
                    try { entries = fs.readdirSync(manifestsDir); } catch { entries = []; }
                    for (const entry of entries) {
                        const bundleDir = path.join(manifestsDir, entry);
                        try {
                            const stat = fs.statSync(bundleDir);
                            if (!stat.isDirectory()) continue;
                            const { manifest } = await loadManifestFromBundle(bundleDir);
                            out.push({
                                plugin: manifest.name,
                                lorePermissions: manifest.lore?.permissions ?? [],
                                defPermissions: manifest.def?.permissions ?? [],
                            });
                        } catch { continue; }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ permissions: out }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // GET /api/plugins/<name>/settings — return declared settings
            // schema + current values. Secret values are returned as
            // { set: true } only (never the actual secret).
            // PUT same path — update one or more settings.
            const settingsMatch = pathname.match(/^\/api\/plugins\/([a-z][a-z0-9-]*)\/settings$/);
            if (settingsMatch && (req.method === 'GET' || req.method === 'PUT')) {
                const pluginName = settingsMatch[1]!;
                try {
                    const bundleDir = path.join(loreHomePath('manifests'), pluginName);
                    const { manifest } = await loadManifestFromBundle(bundleDir);
                    const fields = manifest.lore?.settings ?? [];
                    const settingsFile = path.join(bundleDir, 'settings.json');

                    let stored: Record<string, unknown> = {};
                    try { stored = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8')); } catch { stored = {}; }

                    if (req.method === 'GET') {
                        const values: Record<string, unknown> = {};
                        for (const f of fields) {
                            if (f.type === 'secret') {
                                const has = await hasApiKey(`plugin:${pluginName}:${f.name}`);
                                values[f.name] = { set: has };
                            } else {
                                values[f.name] = stored[f.name] ?? f.default ?? null;
                            }
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ plugin: pluginName, fields, values }));
                        return;
                    }

                    // PUT
                    const body = await readJsonBody(req) as Record<string, unknown>;
                    const next = { ...stored };
                    const errs: string[] = [];
                    for (const f of fields) {
                        if (!(f.name in body)) continue;
                        const v = body[f.name];
                        if (f.type === 'secret') {
                            if (typeof v !== 'string') { errs.push(`${f.name}: secret must be a string`); continue; }
                            await setApiKey(`plugin:${pluginName}:${f.name}`, v);
                            // Don't store the secret in settings.json; keychain only.
                        } else if (f.type === 'string') {
                            if (typeof v !== 'string') { errs.push(`${f.name}: expected string`); continue; }
                            next[f.name] = v;
                        } else if (f.type === 'number') {
                            if (typeof v !== 'number') { errs.push(`${f.name}: expected number`); continue; }
                            next[f.name] = v;
                        } else if (f.type === 'boolean') {
                            if (typeof v !== 'boolean') { errs.push(`${f.name}: expected boolean`); continue; }
                            next[f.name] = v;
                        }
                    }
                    if (errs.length > 0) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'validation failed', details: errs }));
                        return;
                    }
                    await fs.promises.writeFile(settingsFile, JSON.stringify(next, null, 2));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ saved: true, plugin: pluginName }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // GET /api/plugins/manifests — list active manifest plugins
            // and their declarative inspectors. Used by the shell's
            // PluginInspectors view to render manifest-declared tabs.
            if (pathname === '/api/plugins/manifests' && req.method === 'GET') {
                try {
                    const manifestsDir = loreHomePath('manifests');
                    const out: Array<{ name: string; description: string; inspectors: unknown[] }> = [];
                    let entries: string[] = [];
                    try { entries = fs.readdirSync(manifestsDir); } catch { entries = []; }
                    for (const entry of entries) {
                        const bundleDir = path.join(manifestsDir, entry);
                        try {
                            const stat = fs.statSync(bundleDir);
                            if (!stat.isDirectory()) continue;
                            const { manifest } = await loadManifestFromBundle(bundleDir);
                            out.push({
                                name: manifest.name,
                                description: manifest.description,
                                inspectors: manifest.lore?.inspectors ?? [],
                            });
                        } catch {
                            continue; // skip broken bundles
                        }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ manifests: out }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // ── Plugin Wizard endpoints (Tier 1 manifest authoring) ──
            // Used by the in-app PluginWizard UI; called only by trusted
            // browser clients that pass the daemon auth token. All three
            // endpoints expect JSON bodies and return JSON responses.

            // POST /api/plugin-wizard/detect — heuristic schema proposal
            // from a CSV sample. Body: { fileName, csvText }.
            if (pathname === '/api/plugin-wizard/detect' && req.method === 'POST') {
                try {
                    const body = await readJsonBody(req);
                    const fileName = String((body as { fileName?: unknown }).fileName ?? 'sample.csv');
                    const csvText = String((body as { csvText?: unknown }).csvText ?? '');
                    const { parse: parseCsvSync } = await import('csv-parse/sync');
                    const rows = parseCsvSync(csvText, {
                        columns: true,
                        skip_empty_lines: true,
                        trim: true,
                    }) as Array<Record<string, string>>;
                    const { proposeSchema } = await import('../plugins/manifest/heuristics.js');
                    const proposal = proposeSchema(rows, fileName);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        proposal,
                        rowCount: rows.length,
                        sampleRows: rows.slice(0, 5),
                    }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // POST /api/plugin-wizard/dryrun — temp ingest with limit.
            // Body: { manifestYaml, csvText, limit? }. Does NOT write to
            // the live graph; returns what would happen.
            if (pathname === '/api/plugin-wizard/dryrun' && req.method === 'POST') {
                try {
                    const body = await readJsonBody(req);
                    const manifestYaml = String((body as { manifestYaml?: unknown }).manifestYaml ?? '');
                    const csvText = String((body as { csvText?: unknown }).csvText ?? '');
                    const limit = Math.min(100, Number((body as { limit?: unknown }).limit ?? 100));

                    const { parseManifest, validateManifest, runIngest } =
                        await import('../plugins/manifest/index.js');
                    const m = validateManifest(parseManifest(manifestYaml, 'yaml'));
                    const specs = m.lore?.ingest ?? [];
                    if (specs.length === 0) {
                        throw new Error('Manifest declares no ingest specs.');
                    }
                    const spec = specs[0]!;

                    // Write CSV to a temp file the runner can read by relative path.
                    if (!spec.file) {
                        throw new Error('dry-run requires a CSV-source spec with a `file` field; HTTP sources do not yet support dry-run.');
                    }
                    const specFile: string = spec.file;
                    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lore-wizard-dryrun-'));
                    try {
                        const csvFile = path.join(tmpDir, path.basename(specFile));
                        await fs.promises.mkdir(path.dirname(csvFile), { recursive: true });
                        const truncated = csvText.split('\n').slice(0, limit + 1).join('\n');
                        await fs.promises.writeFile(csvFile, truncated);
                        const dryWrites: Array<{ id: string; type: string; label: string; tags: string[] }> = [];
                        const dryRunSpec = { ...spec, file: path.basename(specFile) };
                        const report = await runIngest(dryRunSpec, tmpDir, async (n) => {
                            dryWrites.push({ id: n.id, type: n.type, label: n.label, tags: n.tags });
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            report,
                            sampleWrites: dryWrites.slice(0, 10),
                        }));
                    } finally {
                        await fs.promises.rm(tmpDir, { recursive: true, force: true });
                    }
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // POST /api/plugin-wizard/refine-with-llm — escalate a
            // low-confidence heuristic proposal to the user's BYOK LLM.
            // Body: { proposal, sampleRows, sampleHeaders }.
            // Returns { refinedProposal } when the LLM gives a usable
            // answer; { error, code } when no provider is configured or
            // the LLM call fails — caller should fall back to the
            // heuristic proposal.
            if (pathname === '/api/plugin-wizard/refine-with-llm' && req.method === 'POST') {
                try {
                    const body = await readJsonBody(req) as {
                        proposal?: unknown;
                        sampleRows?: unknown;
                        sampleHeaders?: unknown;
                    };
                    const proposal = body.proposal as Record<string, unknown> | undefined;
                    const sampleRows = (body.sampleRows ?? []) as Array<Record<string, string>>;
                    const sampleHeaders = (body.sampleHeaders ?? []) as string[];
                    if (!proposal) throw new Error('missing `proposal` in body');

                    const cfg = configManager.read();
                    const provider = cfg.llmProvider as LlmProvider;
                    const apiKey = await getApiKey(provider);
                    const needsKey = provider !== 'embedded' && provider !== 'ollama';
                    if (needsKey && !apiKey) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: `No API key configured for provider "${provider}". Add one in Settings or fall back to the heuristic proposal.`,
                            code: 'no_api_key',
                        }));
                        return;
                    }

                    const prompt = buildPluginWizardLlmPrompt(proposal, sampleHeaders, sampleRows);
                    let buffer = '';
                    let llmError: string | null = null;
                    for await (const chunk of llmStream(provider, prompt, apiKey ?? null, undefined)) {
                        if (chunk.kind === 'token' && chunk.content) buffer += chunk.content;
                        else if (chunk.kind === 'error') { llmError = chunk.message ?? 'LLM error'; break; }
                    }
                    if (llmError) {
                        res.writeHead(502, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: llmError, code: 'llm_error' }));
                        return;
                    }

                    // Extract JSON from the LLM's reply. Models often wrap in
                    // ```json fences; tolerate that. If parse fails, return
                    // the raw text so the user can see what came back and
                    // fall back to the heuristic proposal.
                    const refined = extractFirstJsonObject(buffer);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        refinedProposal: refined,
                        rawLlmText: buffer,
                        provider,
                        usable: refined !== null,
                    }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // POST /api/plugin-wizard/save — persist a finished manifest
            // bundle to <LORE_HOME>/manifests/<pluginName>/. Daemon
            // restart required to activate (returned in `next_step`).
            if (pathname === '/api/plugin-wizard/save' && req.method === 'POST') {
                try {
                    const body = await readJsonBody(req);
                    const pluginName = String((body as { pluginName?: unknown }).pluginName ?? '');
                    const manifestYaml = String((body as { manifestYaml?: unknown }).manifestYaml ?? '');
                    const dataFiles = (body as { dataFiles?: Array<{ relPath: string; content: string }> }).dataFiles ?? [];

                    if (!/^[a-z][a-z0-9-]*$/.test(pluginName)) {
                        throw new Error(`pluginName must be kebab-case, got "${pluginName}"`);
                    }
                    // Validate manifest before writing — never persist a broken file.
                    const { parseManifest, validateManifest } = await import('../plugins/manifest/index.js');
                    validateManifest(parseManifest(manifestYaml, 'yaml'));

                    const bundleDir = path.join(loreHomePath('manifests'), pluginName);
                    await fs.promises.mkdir(bundleDir, { recursive: true });
                    const manifestPath = path.join(bundleDir, 'plugin.yaml');
                    await fs.promises.writeFile(manifestPath, manifestYaml);
                    for (const f of dataFiles) {
                        const dest = path.join(bundleDir, f.relPath);
                        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                        await fs.promises.writeFile(dest, f.content);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        saved: true,
                        bundleDir,
                        manifestPath,
                        next_step: 'Restart the Lore daemon to activate: launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore',
                    }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // UI health check: status + active config snapshot + sync adapter status
            if (pathname === '/api/health' && req.method === 'GET') {
                try {
                    const cfg = configManager.read();
                    const orphanState = pluginRegistry.getOrphanState();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    const hot = manifestHotReloader.getStatus();
                    res.end(JSON.stringify({
                        status: orphanState.blocking ? 'orphan_decision_required' : 'ok',
                        version: '2.1.0',
                        activePlugins: cfg.plugins,
                        llmProvider: cfg.llmProvider,
                        workspace: getActiveWorkspaceName(),
                        dataplane: getDataplaneState(),
                        telemetryOptOut: Boolean(cfg.telemetryOptOut),
                        sessions: activeSessions.size,
                        orphans: orphanState.orphans,
                        // Q2.1 — surface the effective deployment mode so
                        // the smoke test and Settings UI can observe it
                        // without reparsing config or env.
                        deploymentMode,
                        // Hot-reload status so the wizard UI can show a
                        // "restart for full type integration" banner.
                        manifestHotReload: {
                            addedSinceBoot: hot.addedSinceBoot,
                            reloadedSinceBoot: hot.reloadedSinceBoot,
                            needsRestartForCoreEnums: hot.needsRestartForCoreEnums,
                            namesHotLoaded: hot.namesHotLoaded,
                        },
                    }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'degraded', error: (err as Error).message }));
                }
                return;
            }

            // Q1.1 closure — Manual sync endpoints. The daemon's
            // syncEngine holds the live, keychain-upgraded adapter;
            // the `lore sync` CLI creates its own SyncEngine with a
            // null adapter (offline-only fallback), so it cannot
            // drive the Dataplane round-trip. These endpoints let
            // the Lore UI, CLI over HTTP, or an external caller
            // trigger the real push/pull through the bound adapter.
            //
            //   POST /api/sync/push  → pushPending(); drains WAL on
            //                          success, reports counts + errors
            //   POST /api/sync/pull  → pullRemote(); upserts remote
            //                          deltas into local Kùzu
            //   POST /api/sync/now   → full cycle (push then pull)
            //
            // Airplane-safe: if no adapter or the Dataplane is
            // unreachable, returns a 200 with `ok: false` + human
            // error string rather than throwing; local graph is
            // untouched.
            if (pathname === '/api/sync/push' && req.method === 'POST') {
                try {
                    const result = await syncEngine.pushPending();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        ok: result.failures === 0,
                        nodesPushed: result.nodesPushed,
                        edgesPushed: result.edgesPushed,
                        failures: result.failures,
                        errors: result.errors,
                    }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
                }
                return;
            }
            if (pathname === '/api/sync/pull' && req.method === 'POST') {
                try {
                    const result = await syncEngine.pullRemote();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, ...result }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
                }
                return;
            }
            if (pathname === '/api/sync/now' && req.method === 'POST') {
                try {
                    const result = await syncEngine.sync();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        ok: result.push.failures === 0,
                        push: result.push,
                        pull: result.pull,
                    }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
                }
                return;
            }

            // Q1.4 — Plugin IR introspection. Returns the declared IR
            // descriptor for every active plugin: owned node/edge
            // tables, node/edge kinds, and IR version. Useful for:
            //   - Admin UI: "what does this plugin bring to the graph?"
            //   - Analytical projection (Q1.5): the projection engine
            //     reads node/edge kinds from here to know which tables
            //     the plugin opts into for aggregation queries.
            //   - Scaffolder validation: new plugins can diff their
            //     IR against live descriptors to catch collisions
            //     before boot.
            // Plugins that haven't adopted `ir` yet get a synthesized
            // descriptor with `version: "0.0.0"` — the migration signal.
            if (pathname === '/api/plugins/ir' && req.method === 'GET') {
                try {
                    const entries = pluginRegistry.collectIR();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ plugins: entries }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // Q1.5 — Analytical projection catalog.
            //
            //   GET /api/analytics/projections
            //     → { projections: [{ plugin, fqId, label, description,
            //                          columns, intentKeywords }...],
            //         enabled: boolean, perPluginOptOut: string[] }
            //
            // The UI enumerates this to populate a projection picker in
            // the Q1.6 canvas view-stack. The `enabled` flag + opt-out
            // list are echoed back so the UI can show "Analytical
            // projections are disabled in Settings" rather than "no
            // projections available" when the distinction matters.
            if (pathname === '/api/analytics/projections' && req.method === 'GET') {
                try {
                    const config = configManager.read();
                    const settings = config.analyticalProjections ?? { enabled: true, perPluginOptOut: [] };
                    const entries = pluginRegistry.collectAnalyticalProjections();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        enabled: settings.enabled,
                        perPluginOptOut: settings.perPluginOptOut ?? [],
                        projections: entries.map((e) => ({
                            plugin: e.plugin,
                            fqId: e.fqId,
                            id: e.projection.id,
                            label: e.projection.label,
                            description: e.projection.description,
                            columns: e.projection.columns,
                            intentKeywords: e.projection.intentKeywords,
                        })),
                    }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // Q1.5 — Run a specific projection by fully-qualified id.
            //
            //   POST /api/analytics/projections/run
            //     body: { fqId: "<plugin>/<projection-id>" }
            //     → { columns, rows, sourceNodeIds, elapsedMs }
            //     → 404 when fqId doesn't match or is opted out
            //     → 403 when analyticalProjections.enabled === false
            //
            // Runs under the same PluginGraphContext the MCP tool uses;
            // airplane-safe by hook contract.
            if (pathname === '/api/analytics/projections/run' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const { fqId } = JSON.parse(body || '{}') as { fqId?: string };
                        if (!fqId || typeof fqId !== 'string') {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'fqId (string) required in body' }));
                            return;
                        }
                        const config = configManager.read();
                        if (config.analyticalProjections?.enabled === false) {
                            res.writeHead(403, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Analytical projections are disabled in Settings' }));
                            return;
                        }
                        const graphCtx = graph.createPluginGraphContext();
                        const result = await pluginRegistry.runAnalyticalProjection(fqId, graphCtx);
                        if (!result) {
                            res.writeHead(404, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                error: `Projection '${fqId}' not found or opted out.`,
                                available: pluginRegistry.collectAnalyticalProjections().map((e) => e.fqId),
                            }));
                            return;
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ fqId, ...result }));
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // V2.1: Workspace registry — Slack-style hard switching between
            // independent graphs. Each workspace = its own .lore/ directory,
            // never cross-visible. Switching requires a daemon restart so the
            // Kùzu graph + VerbatimStore can re-initialize against the new path.
            if (pathname === '/api/workspaces' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(loadWorkspaces()));
                return;
            }

            if (pathname === '/api/workspaces' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const { name } = JSON.parse(body || '{}') as { name?: string };
                        if (!name) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'name required' }));
                            return;
                        }
                        const entry = createWorkspace(name);
                        res.writeHead(201, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ created: entry, workspaces: loadWorkspaces() }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            if (pathname === '/api/workspaces/switch' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const { name } = JSON.parse(body || '{}') as { name?: string };
                        if (!name) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'name required' }));
                            return;
                        }
                        if (name === getActiveWorkspaceName()) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ active: name, restarting: false }));
                            return;
                        }
                        switchWorkspace(name);
                        res.writeHead(202, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ active: name, restarting: true }));
                        // Defer exit so the response flushes cleanly; launchd
                        // KeepAlive=true will relaunch immediately and the daemon
                        // will bind to the new workspace on the next boot.
                        setTimeout(() => {
                            console.error(`[Lore MCP] Workspace switched to "${name}" — exiting for restart.`);
                            process.exit(0);
                        }, 150);
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // POST /api/workspaces/rename  body: { oldName, newName }
            // Renames a workspace's label without moving its data on disk.
            // No daemon restart needed — workspaces.json is read fresh on each
            // loadWorkspaces() call. Active-workspace rename is supported.
            if (pathname === '/api/workspaces/rename' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    const startMs = Date.now();
                    try {
                        const { oldName, newName } = JSON.parse(body || '{}') as { oldName?: string; newName?: string };
                        if (!oldName || !newName) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'oldName and newName required' }));
                            return;
                        }
                        const next = renameWorkspace(oldName, newName);
                        auditLog.log({
                            toolName: 'workspaces.rename',
                            args: { oldName, newName },
                            result: 'success',
                            durationMs: Date.now() - startMs,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(next));
                    } catch (err) {
                        auditLog.log({
                            toolName: 'workspaces.rename',
                            args: { rawBody: body.slice(0, 200) },
                            result: 'error',
                            resultDetail: (err as Error).message,
                            durationMs: Date.now() - startMs,
                        });
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            if (url.startsWith('/api/workspaces/') && req.method === 'DELETE') {
                const raw = decodeURIComponent(url.slice('/api/workspaces/'.length));
                // C6 — workspace deletion is destructive: audit every
                // attempt regardless of outcome.
                const startMs = Date.now();
                try {
                    const name = kebabCase(raw);
                    const next = deleteWorkspace(name);
                    auditLog.log({
                        toolName: 'workspaces.delete',
                        args: { name },
                        result: 'success',
                        durationMs: Date.now() - startMs,
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(next));
                } catch (err) {
                    auditLog.log({
                        toolName: 'workspaces.delete',
                        args: { name: raw },
                        result: 'error',
                        resultDetail: (err as Error).message,
                        durationMs: Date.now() - startMs,
                    });
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            /* ─── /api/repos — Phase 1b Add-Project surface ────────── */
            // Routes wrap the developer plug-in's repoOps surface
            // (decision-add-project-ui-phase1-defaults-2026-04-27).
            // Plug-in boundary preserved: core dispatches by URL only;
            // all gitnexus / git knowledge lives in the dev plug-in's
            // DeveloperApi (`pluginRegistry.active().find(p => p.name === 'developer').api`).
            //
            //   GET    /api/repos                       — list with freshness
            //   POST   /api/repos/discover              — {parentPath, depth?, maxDepth?}
            //   POST   /api/repos                       — {path, installHook?, force?}
            //   POST   /api/repos/batch                 — {paths[], installHook?}
            //   GET    /api/repos/:name/freshness       — ?staleAfterHours=N
            //   DELETE /api/repos/:name                 — drop from registry + clear symbols
            //
            // Long-running ops (add, batch) respond synchronously today;
            // SSE progress channel deferred to a follow-up slice.
            if (pathname === '/api/repos' && req.method === 'GET') {
                try {
                    const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                    const devApi = devPlugin?.api as {
                        listGitNexusRepos: () => Array<{ name: string; path: string; indexedAt: string; lastCommit?: string; stats?: Record<string, number> }>;
                        getRepoFreshness: (name: string, h?: number) => unknown;
                        getRepoTags: (name: string) => string[];
                    } | undefined;
                    if (!devApi) {
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'developer plug-in not active' }));
                        return;
                    }
                    const repos = devApi.listGitNexusRepos();
                    const enriched = repos.map((r) => ({
                        ...r,
                        freshness: devApi.getRepoFreshness(r.name, 24),
                        tags: devApi.getRepoTags(r.name),
                    }));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ count: enriched.length, repos: enriched }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // GET /api/repos/tags  →  list of all tags + their repos
            if (pathname === '/api/repos/tags' && req.method === 'GET') {
                try {
                    const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                    const devApi = devPlugin?.api as { listAllRepoTags: () => Array<{ tag: string; repos: string[] }> } | undefined;
                    if (!devApi) {
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'developer plug-in not active' }));
                        return;
                    }
                    const tags = devApi.listAllRepoTags();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ count: tags.length, tags }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // PATCH /api/repos/:name/tags  body: { tags: string[] }
            if (url.startsWith('/api/repos/') && url.endsWith('/tags') && req.method === 'PATCH') {
                const tail = url.slice('/api/repos/'.length);
                const name = decodeURIComponent(tail.slice(0, -('/tags'.length)));
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const { tags } = JSON.parse(body || '{}') as { tags?: string[] };
                        if (!Array.isArray(tags)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'tags array required' }));
                            return;
                        }
                        const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                        const devApi = devPlugin?.api as { setRepoTags: (n: string, t: string[]) => string[] } | undefined;
                        if (!devApi) {
                            res.writeHead(503, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'developer plug-in not active' }));
                            return;
                        }
                        const normalized = devApi.setRepoTags(name, tags);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ name, tags: normalized }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            if (pathname === '/api/repos/discover' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const { parentPath, depth, maxDepth } = JSON.parse(body || '{}') as { parentPath?: string; depth?: 'shallow' | 'deep'; maxDepth?: number };
                        if (!parentPath) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'parentPath required' }));
                            return;
                        }
                        const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                        const devApi = devPlugin?.api as { discoverRepos: (p: string, o?: { depth?: 'shallow' | 'deep'; maxDepth?: number }) => unknown[] } | undefined;
                        if (!devApi) {
                            res.writeHead(503, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'developer plug-in not active' }));
                            return;
                        }
                        const found = devApi.discoverRepos(parentPath, { depth, maxDepth });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ count: found.length, found }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            if (pathname === '/api/repos' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const { path: repoPath, installHook, force } = JSON.parse(body || '{}') as { path?: string; installHook?: boolean; force?: boolean };
                        if (!repoPath) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'path required' }));
                            return;
                        }
                        const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                        const devApi = devPlugin?.api as { addRepo: (p: string, o?: { installHook?: boolean; force?: boolean }) => Promise<unknown> } | undefined;
                        if (!devApi) {
                            res.writeHead(503, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'developer plug-in not active' }));
                            return;
                        }
                        const result = await devApi.addRepo(repoPath, { installHook, force });
                        res.writeHead(201, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            if (pathname === '/api/repos/batch' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const { paths, installHook } = JSON.parse(body || '{}') as { paths?: string[]; installHook?: boolean };
                        if (!Array.isArray(paths) || paths.length === 0) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'paths[] required (non-empty)' }));
                            return;
                        }
                        const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                        const devApi = devPlugin?.api as { addRepo: (p: string, o?: { installHook?: boolean }) => Promise<{ name: string; symbolCount?: number; hookInstalled?: boolean }> } | undefined;
                        if (!devApi) {
                            res.writeHead(503, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'developer plug-in not active' }));
                            return;
                        }
                        const results: Array<{ path: string; ok: boolean; result?: unknown; error?: string }> = [];
                        for (const p of paths) {
                            try {
                                const result = await devApi.addRepo(p, { installHook });
                                results.push({ path: p, ok: true, result });
                            } catch (e) {
                                results.push({ path: p, ok: false, error: (e as Error).message });
                            }
                        }
                        const okCount = results.filter((r) => r.ok).length;
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ total: results.length, ok: okCount, failed: results.length - okCount, results }));
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // /api/repos/:name/freshness  AND  DELETE /api/repos/:name
            if (url.startsWith('/api/repos/') && (req.method === 'GET' || req.method === 'DELETE')) {
                const tail = url.slice('/api/repos/'.length);
                const [rawName, queryStr] = tail.split('?');
                const name = decodeURIComponent(rawName.split('/')[0]);
                const subpath = rawName.includes('/') ? rawName.slice(name.length + 1) : '';

                if (req.method === 'GET' && subpath === 'freshness') {
                    try {
                        const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                        const devApi = devPlugin?.api as { getRepoFreshness: (n: string, h?: number) => unknown } | undefined;
                        if (!devApi) {
                            res.writeHead(503, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'developer plug-in not active' }));
                            return;
                        }
                        const params = new URLSearchParams(queryStr ?? '');
                        const staleAfterHours = Number(params.get('staleAfterHours') ?? 24);
                        const fresh = devApi.getRepoFreshness(name, staleAfterHours);
                        if (!fresh) {
                            res.writeHead(404, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: `repo not found: ${name}` }));
                            return;
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(fresh));
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                    return;
                }

                if (req.method === 'DELETE' && !subpath) {
                    try {
                        const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                        const devApi = devPlugin?.api as { removeRepo: (n: string) => Promise<unknown> } | undefined;
                        if (!devApi) {
                            res.writeHead(503, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'developer plug-in not active' }));
                            return;
                        }
                        const result = await devApi.removeRepo(name);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                    return;
                }
                // Otherwise fall through.
            }

            /* ─── /api/code-similar — Phase 2 Pre-write check ─────── */
            // Wraps the developer plug-in's evaluatePreWrite (same engine
            // as the `code_similar` MCP tool). Hook adapters (Claude
            // Code PreToolUse, Cursor preToolUse) POST here to get a
            // structured decision before the agent's Write/Edit lands.
            //
            //   POST /api/code-similar
            //   body: { content, language?, repo?, k?, warn_threshold? }
            //   200: { decision: 'allow'|'warn', recommendation, top_match, matches[], strong_match }
            if (pathname === '/api/code-similar' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const { content, language, repo, k, warn_threshold } = JSON.parse(body || '{}') as {
                            content?: string; language?: string; repo?: string; k?: number; warn_threshold?: number;
                        };
                        if (!content || typeof content !== 'string') {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'content (string) required' }));
                            return;
                        }
                        const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                        const devApi = devPlugin?.api as {
                            evaluatePreWrite: (c: string, o?: { language?: string; repo?: string; k?: number; warnThreshold?: number }) => Promise<{
                                decision: 'allow' | 'warn';
                                recommendation: string;
                                topMatch: unknown;
                                matches: Array<{ name: string; kind: string; filePath: string; startLine?: number; repo: string; score: number; loreNodeId: string }>;
                                strongMatch: boolean;
                            }>;
                        } | undefined;
                        if (!devApi) {
                            res.writeHead(503, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'developer plug-in not active' }));
                            return;
                        }
                        const decision = await devApi.evaluatePreWrite(content, {
                            language,
                            repo,
                            k: k ?? 5,
                            warnThreshold: warn_threshold,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            decision: decision.decision,
                            recommendation: decision.recommendation,
                            strong_match: decision.strongMatch,
                            top_match: decision.topMatch,
                            matches: decision.matches.map((m) => ({
                                name: m.name,
                                kind: m.kind,
                                file: `${m.filePath}${m.startLine ? ':' + m.startLine : ''}`,
                                repo: m.repo,
                                similarity: Number(m.score.toFixed(3)),
                                lore_node_id: m.loreNodeId,
                            })),
                        }));
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            /* ─── /api/code/cypher — Phase 7 read-only Cypher passthrough ─── */
            //
            // Daemon-level HTTP route that mirrors the code_cypher MCP tool.
            // Used by atlas-cutover-execute.mjs to enumerate existing
            // CodeSymbol rows for the oldId → newId mapping table without
            // needing a live MCP session. Gated by the same read-only
            // sentinel scan as the MCP path (CYPHER_WRITE_KEYWORDS).
            //
            //   POST /api/code/cypher
            //   body: { query: string, parameters?: Record<string,unknown>, max_rows?: number }
            //   200: { rows: Array<...>, truncated: boolean, count: number }
            //   400: { error: 'read-only', rejectedKeyword: string }
            //   503: { error: 'developer plug-in not active' }
            if (pathname === '/api/code/cypher' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const { query, parameters, max_rows } = JSON.parse(body || '{}') as {
                            query?: string;
                            parameters?: Record<string, unknown>;
                            max_rows?: number;
                        };
                        if (!query || typeof query !== 'string') {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'query (string) required' }));
                            return;
                        }
                        const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                        const devApi = devPlugin?.api as {
                            executeRawCypher: (
                                q: string,
                                params?: Record<string, unknown>,
                                opts?: { maxRows?: number },
                            ) => Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }>;
                        } | undefined;
                        if (!devApi) {
                            res.writeHead(503, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'developer plug-in not active' }));
                            return;
                        }
                        // Read-only sentinel scan (mirrors mcp/handlers-phase61
                        // CYPHER_WRITE_KEYWORDS — single source in dev plugin's
                        // api.ts findWriteKeyword, but we can't import it here
                        // without crossing the plugin boundary; the same list
                        // is duplicated below and kept in sync by hand).
                        const WRITE_KEYWORDS = ['CREATE', 'DELETE', 'DROP', 'MERGE', 'SET', 'DETACH', 'COPY', 'INSTALL', 'LOAD'];
                        const upper = query.toUpperCase();
                        for (const kw of WRITE_KEYWORDS) {
                            if (new RegExp(`\\b${kw}\\b`).test(upper)) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    error: 'read-only',
                                    rejectedKeyword: kw,
                                    note: '/api/code/cypher is read-only.',
                                }));
                                return;
                            }
                        }
                        const result = await devApi.executeRawCypher(query, parameters, {
                            maxRows: max_rows ?? 1000,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            count: result.rows.length,
                            truncated: result.truncated,
                            rows: result.rows,
                        }));
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // V2.1: Reconnect the knowledge graph via semantic neighbors.
            // POST body: {k?, threshold?, apply?}. Dry-run by default — returns
            // proposed edges + similarity histogram so the UI can calibrate
            // the threshold before committing. apply=true prunes prior
            // inferred edges and inserts the new set.
            if (pathname === '/api/graph/reconnect' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    const startMs = Date.now();
                    try {
                        const { k, threshold, apply, force, incremental } = JSON.parse(body || '{}') as {
                            k?: number;
                            threshold?: number;
                            apply?: boolean;
                            force?: boolean;
                            /** C6.5 — when true, filter to nodes updated after the cursor. */
                            incremental?: boolean;
                        };
                        // Resolve the since-cursor when incremental requested.
                        let since: string | undefined;
                        if (incremental) {
                            const cursor = readCursor(graphBasePath);
                            since = cursor?.lastReconnectAt;
                        }
                        // C6 — reconnect WITH apply=true mutates the graph;
                        // dry-run does not. Only consent-gate apply mode to
                        // avoid blocking simple calibration runs.
                        let approvalId: string | undefined;
                        if (apply) {
                            const req = consentManager.request(
                                'graph.reconnect',
                                { k, threshold, apply, force },
                                { context: 'Rebuild semantic edges across the graph. Existing inferred edges will be pruned and recreated. May take seconds to minutes on large graphs.' },
                            );
                            approvalId = req.id;
                            const decision = await req.wait;
                            if (!decision.approved) {
                                auditLog.log({
                                    toolName: 'graph.reconnect',
                                    args: { k, threshold, apply, force },
                                    result: 'denied-by-user',
                                    resultDetail: decision.reason,
                                    approvalId,
                                    durationMs: Date.now() - startMs,
                                });
                                res.writeHead(403, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'consent denied', reason: decision.reason }));
                                return;
                            }
                        }
                        // Q2.2 — reconnect is a local-only plugin-heavy op today;
                        // cloud-mode reconnect is a slice-3 follow-up.
                        const result = await reconnectGraph(graph as LocalGraph, verbatimStore as VerbatimStore, pluginRegistry, {
                            k,
                            minSim: threshold,
                            dryRun: !apply,
                            force,
                            since,
                        });
                        // C6.5 — on successful apply, persist the cursor so
                        // the next incremental run picks up from here.
                        if (apply) {
                            try {
                                writeCursor(graphBasePath, incremental ? 'incremental' : 'full', {
                                    candidatesScanned: result.candidatesScanned,
                                    embeddingsAdded: result.embeddingsAdded,
                                    embeddingsSkipped: result.embeddingsSkipped,
                                    coreEdgesInserted: result.coreEdgesInserted,
                                });
                            } catch (cursorErr) {
                                console.error(`[reconnect] cursor write failed: ${(cursorErr as Error).message}`);
                            }
                        }
                        auditLog.log({
                            toolName: 'graph.reconnect',
                            args: { k, threshold, apply, force, incremental },
                            result: 'success',
                            approvalId,
                            durationMs: Date.now() - startMs,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        auditLog.log({
                            toolName: 'graph.reconnect',
                            args: {},
                            result: 'error',
                            resultDetail: (err as Error).message,
                            durationMs: Date.now() - startMs,
                        });
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // V2.1: Reconsume — the "refresh everything" button. Does the
            // full re-embed + reconnect pipeline in one call: pulls every
            // LoreNode + CodeFile (with child-symbol preview) + CodeSymbol,
            // re-embeds against the latest content, prunes old inferred
            // edges, and lays a fresh cross-pillar edge set. Always applies.
            if (pathname === '/api/graph/reconsume' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    const startMs = Date.now();
                    try {
                        const { k, threshold, force } = JSON.parse(body || '{}') as {
                            k?: number;
                            threshold?: number;
                            force?: boolean;
                        };
                        // C6 — reconsume always applies + always prunes; gate it.
                        const cReq = consentManager.request(
                            'graph.reconsume',
                            { k, threshold, force },
                            { context: 'Re-embed every node and rebuild the entire inferred-edge set. Runs the full reconnect pipeline from scratch. Minutes of CPU on large graphs.' },
                        );
                        const decision = await cReq.wait;
                        if (!decision.approved) {
                            auditLog.log({
                                toolName: 'graph.reconsume',
                                args: { k, threshold, force },
                                result: 'denied-by-user',
                                resultDetail: decision.reason,
                                approvalId: cReq.id,
                                durationMs: Date.now() - startMs,
                            });
                            res.writeHead(403, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'consent denied', reason: decision.reason }));
                            return;
                        }
                        // Q2.2 — see reconnectGraph note above; cloud-mode path deferred to slice 3.
                        const result = await reconnectGraph(graph as LocalGraph, verbatimStore as VerbatimStore, pluginRegistry, {
                            k,
                            minSim: threshold,
                            dryRun: false,
                            pruneInferred: true,
                            force,
                        });
                        auditLog.log({
                            toolName: 'graph.reconsume',
                            args: { k, threshold, force },
                            result: 'success',
                            approvalId: cReq.id,
                            durationMs: Date.now() - startMs,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        auditLog.log({
                            toolName: 'graph.reconsume',
                            args: {},
                            result: 'error',
                            resultDetail: (err as Error).message,
                            durationMs: Date.now() - startMs,
                        });
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // V2.1 / Option C: ingest-files is developer-plugin-owned.
            // Core reaches it through the plugin's opaque api surface;
            // returns 501 if the developer plugin isn't active here.
            if (pathname === '/api/graph/ingest-files' && req.method === 'POST') {
                try {
                    const devPlugin = pluginRegistry.active().find((p) => p.name === 'developer');
                    const devApi = devPlugin?.api as
                        | { ingestFilesFromSymbols: () => Promise<{ filesCreated: number; edgesCreated: number }> }
                        | undefined;
                    if (!devApi) {
                        res.writeHead(501, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'ingest-files requires the "developer" plugin (not active in this workspace)' }));
                        return;
                    }
                    const stats = await devApi.ingestFilesFromSymbols();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, ...stats }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // Orphan plugin resolution endpoint. GET returns state; POST applies
            // the user's decision (keep/drop/reenable). 'drop' requires the
            // literal string "DROP" in confirm to match the CLI/UI prompt.
            if (pathname === '/api/orphan' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(pluginRegistry.getOrphanState()));
                return;
            }

            if (pathname === '/api/orphan' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const { plugin, decision, confirm } = JSON.parse(body || '{}') as {
                            plugin?: string;
                            decision?: 'keep' | 'drop' | 'reenable';
                            confirm?: string;
                        };
                        if (!plugin || !decision) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'plugin and decision required' }));
                            return;
                        }
                        if (decision === 'drop' && confirm !== 'DROP') {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'drop requires confirm="DROP"' }));
                            return;
                        }
                        const next = pluginRegistry.resolveOrphan(plugin, decision);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            resolved: plugin,
                            decision,
                            orphanState: pluginRegistry.getOrphanState(),
                            config: next,
                        }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // UI config read: returns the live config (without API keys)
            if (pathname === '/api/config' && req.method === 'GET') {
                try {
                    const cfg = configManager.read();
                    const hasKey = await hasApiKey(cfg.llmProvider);
                    const capability = getCapability(cfg.llmProvider);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ...cfg, hasApiKey: hasKey, capability }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // UI config write: PATCH partial updates. `apiKey` goes to keychain,
            // all other fields merge into .lore/config.json.
            if (pathname === '/api/config' && req.method === 'PATCH') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const update = JSON.parse(body || '{}') as Record<string, unknown>;
                        const { apiKey, ...configFields } = update;
                        const next = configManager.patch(configFields);
                        // V2.2: mirror the keep-hot flag to the LLM dispatcher
                        // so idle-unload behavior updates without a daemon
                        // restart. Always push the resolved value (next.*)
                        // rather than the incoming update to avoid partial
                        // patches leaving stale state.
                        setEmbeddedModelKeepHot(Boolean(next.keepEmbeddedModelHot));
                        // Q1.3 — mirror the read-cache settings to the
                        // running LocalGraph so a Settings flip takes
                        // effect without a daemon restart. The env
                        // killswitch LORE_CACHE_DISABLED=1 still wins.
                        if (next.localCache) {
                            graph.reconfigureCache(next.localCache);
                        }
                        if (typeof apiKey === 'string' && apiKey.length > 0) {
                            const ok = await setApiKey(next.llmProvider, apiKey);
                            if (!ok) {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'keychain write failed' }));
                                return;
                            }
                        } else if (apiKey === null) {
                            await deleteApiKey(next.llmProvider);
                        }
                        const hasKey = await hasApiKey(next.llmProvider);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ...next, hasApiKey: hasKey, capability: getCapability(next.llmProvider) }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // File extraction gate (Phase 2). The server reads the LIVE
            // capability manifest of the configured LLM and either accepts
            // + returns a chunking/caption plan (202), or rejects with the
            // accepted-types list (415). BYOK only — DEF Cloud path is
            // greyed out in UI until the Groundfloor sign-in workflow ships.
            if (pathname === '/api/extract' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const payload = JSON.parse(body || '{}') as Partial<ExtractPayload>;
                        if (!payload.filename || !payload.mimeType || payload.content === undefined) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'filename, mimeType, content required' }));
                            return;
                        }
                        const cfg = configManager.read();
                        const cap = getCapability(cfg.llmProvider);
                        const decision = decideExtraction(payload as ExtractPayload, cap);
                        res.writeHead(decision.status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            accepted: decision.accepted,
                            provider: cfg.llmProvider,
                            capability: cap,
                            ...decision.body,
                        }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // V2.2: chat action dispatcher. When the LLM emits an
            // action-suggestion token like {{action:reconnect_node|...}}
            // the UI renders it as a button. Click posts here with
            // { action, params }. Server enforces the whitelist — only
            // the exact action names from EMBEDDED_SYSTEM_PROMPT's
            // action registry are honored. Every other string returns 400.
            //
            // Supported actions (Phase 1 — intentionally narrow):
            //   reconnect_node { nodeId } — rebuild semantic_neighbor
            //     edges for a single node via reconnectOneNode
            //   open_reconnect_settings — pure UI hint, server acks OK
            //
            // Adding a new action requires: updating EMBEDDED_SYSTEM_PROMPT
            // action registry, updating the whitelist here, and updating
            // the UI action dispatcher. All three in one PR.
            if (pathname === '/api/chat/action' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    const startedAt = Date.now();
                    let auditAction = 'unknown';
                    let auditArgs: Record<string, unknown> = {};
                    let auditResult: 'success' | 'error' | 'denied-by-policy' = 'success';
                    let auditResultDetail: string | undefined;
                    let statusCode = 200;
                    let responseBody: unknown = null;
                    try {
                        const payload = JSON.parse(body || '{}') as { action?: string; params?: Record<string, unknown> };
                        const action = payload.action ?? '';
                        const params = payload.params ?? {};
                        auditAction = action;
                        auditArgs = params;

                        if (action === 'reconnect_node') {
                            const rawId = typeof params['nodeId'] === 'string' ? (params['nodeId'] as string) : '';
                            if (!rawId) {
                                statusCode = 400;
                                responseBody = { error: 'nodeId required' };
                                auditResult = 'denied-by-policy';
                                auditResultDetail = 'missing nodeId';
                            } else {
                                // Q1.8 — prefix routing. `lore:` or no prefix →
                                // core LoreNode + reconnectOneNode. Any other
                                // `<prefix>:<id>` shape → dispatch to the first
                                // active plugin whose `recalibrate` claims it.
                                // This replaces the old 404 on plugin-owned nodes
                                // (file:, symbol:) and makes Recalibrate work on
                                // CodeFile / CodeSymbol drawer entries.
                                const isCoreId = rawId.startsWith('lore:') || !rawId.includes(':');
                                if (isCoreId) {
                                    const nodeId = rawId.startsWith('lore:') ? rawId.slice('lore:'.length) : rawId;
                                    const node = await graph.getNode(nodeId);
                                    if (!node) {
                                        statusCode = 404;
                                        responseBody = { error: `node '${nodeId}' not found` };
                                        auditResult = 'denied-by-policy';
                                        auditResultDetail = `node not found: ${nodeId}`;
                                    } else {
                                        // Q2.2 — see reconnect note above; cloud-mode reconnect deferred.
                                        const result = await reconnectOneNode(graph as LocalGraph, verbatimStore as VerbatimStore, pluginRegistry, {
                                            id: node.id,
                                            label: node.label,
                                            content: node.content,
                                            tags: node.tags,
                                            type: node.type,
                                            project: node.project,
                                            ecosystem: node.ecosystem,
                                        });
                                        responseBody = {
                                            ok: true,
                                            action: 'reconnect_node',
                                            nodeId,
                                            label: node.label,
                                            edgesAdded: result.added,
                                            confidences: result.confidences,
                                        };
                                        auditResultDetail = `edgesAdded=${result.added}`;
                                    }
                                } else {
                                    // Plugin-owned marker. Iterate active plugins;
                                    // first non-null return wins. If none handle,
                                    // 400 — this is a misrouted action, not a
                                    // missing node.
                                    const pluginCtx = {
                                        graph,
                                        verbatimStore,
                                        syncEngine,
                                        syncAdapter: adapter,
                                        schemaLoader,
                                        scope: detectedScope,
                                        loreDir,
                                    };
                                    let handled: { added: number; confidences: number[] } | null = null;
                                    let handledBy = '';
                                    for (const plugin of pluginRegistry.active()) {
                                        if (typeof plugin.recalibrate !== 'function') continue;
                                        try {
                                            const r = await plugin.recalibrate(rawId, pluginCtx);
                                            if (r) {
                                                handled = r;
                                                handledBy = plugin.name;
                                                break;
                                            }
                                        } catch (recErr) {
                                            console.error(`[/api/chat/action] plugin '${plugin.name}'.recalibrate threw for '${redactId(rawId)}': ${redactError(recErr)}`);
                                        }
                                    }
                                    if (!handled) {
                                        statusCode = 400;
                                        responseBody = { error: `no active plugin claims prefix for '${rawId}'` };
                                        auditResult = 'denied-by-policy';
                                        auditResultDetail = `no plugin route: ${rawId}`;
                                    } else {
                                        responseBody = {
                                            ok: true,
                                            action: 'reconnect_node',
                                            nodeId: rawId,
                                            label: rawId,
                                            edgesAdded: handled.added,
                                            confidences: handled.confidences,
                                            handledBy: `plugin:${handledBy}`,
                                        };
                                        auditResultDetail = `plugin=${handledBy} edgesAdded=${handled.added}`;
                                    }
                                }
                            }
                        } else if (action === 'open_reconnect_settings') {
                            responseBody = {
                                ok: true,
                                action: 'open_reconnect_settings',
                                uiHint: { openPanel: 'settings', scrollTo: 'graph-connections' },
                            };
                        } else {
                            statusCode = 400;
                            responseBody = { error: `unknown action '${action}'` };
                            auditResult = 'denied-by-policy';
                            auditResultDetail = `unknown action: ${action}`;
                        }
                    } catch (actionErr) {
                        statusCode = 500;
                        responseBody = { error: (actionErr as Error).message };
                        auditResult = 'error';
                        auditResultDetail = (actionErr as Error).message;
                    } finally {
                        // V2.2: every chat-action dispatch (button click OR
                        // auto-executed) gets audit-logged with action name,
                        // args, outcome, and duration. Append in finally
                        // so failure paths log too. Same AuditLog the rest
                        // of the server uses.
                        try {
                            auditLog.log({
                                toolName: `chat_action:${auditAction}`,
                                args: auditArgs,
                                result: auditResult,
                                resultDetail: auditResultDetail,
                                durationMs: Date.now() - startedAt,
                            });
                        } catch { /* never let audit-log errors break the response */ }
                        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(responseBody));
                    }
                });
                return;
            }

            // V2.2: thumbs-up / thumbs-down feedback recording.
            // Append-only; no authoritative dedup at write time —
            // aggregate() keeps the most recent rating per messageId.
            // Lets a user change their mind without losing history.
            if (pathname === '/api/feedback' && req.method === 'POST') {
                let fbBody = '';
                req.on('data', (chunk: Buffer) => { fbBody += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const payload = JSON.parse(fbBody || '{}') as {
                            messageId?: string;
                            provider?: string;
                            model?: string;
                            rating?: 'up' | 'down';
                            query?: string;
                            responseLength?: number;
                        };
                        if (!payload.messageId || !payload.rating || (payload.rating !== 'up' && payload.rating !== 'down')) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'messageId + rating (up|down) required' }));
                            return;
                        }
                        feedbackStore.record({
                            messageId: payload.messageId,
                            provider: payload.provider ?? 'unknown',
                            model: payload.model ?? 'unknown',
                            rating: payload.rating,
                            queryHash: payload.query ? FeedbackStore.hashQuery(payload.query) : '',
                            responseLength: payload.responseLength,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
                    } catch (fbErr) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (fbErr as Error).message }));
                    }
                });
                return;
            }

            // V2.2: aggregate feedback stats for the Settings panel.
            // Window defaults to 30 days, capped at 365 to bound read.
            if (url.startsWith('/api/feedback/stats') && req.method === 'GET') {
                try {
                    const parsed = new URL(url, 'http://localhost');
                    const days = Math.min(365, Math.max(1, parseInt(parsed.searchParams.get('days') ?? '30', 10) || 30));
                    const agg = feedbackStore.aggregate(days);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ windowDays: days, ...agg }));
                } catch (statsErr) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (statsErr as Error).message }));
                }
                return;
            }

            // Chat SSE stream — routes every message to the local/BYOK LLM.
            // Never falls back to any cloud pathway silently.
            if (pathname === '/api/chat' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    let message = '';
                    let forceProvider: string | undefined;
                    try {
                        const parsed = JSON.parse(body || '{}') as { message?: string; forceProvider?: string };
                        message = (parsed.message ?? '').trim();
                        // V2.2: optional per-call override so the UI can
                        // "escalate" a query from the embedded model to a
                        // BYOK model without changing the user's persistent
                        // default. Valid values match the providers in
                        // llmDispatch's DEFAULT_MODELS; unknown values fall
                        // back to config so a malformed client doesn't
                        // bypass user intent.
                        if (parsed.forceProvider && ['embedded', 'anthropic', 'openai', 'ollama'].includes(parsed.forceProvider)) {
                            forceProvider = parsed.forceProvider;
                        }
                    } catch {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'invalid JSON body' }));
                        return;
                    }
                    if (!message) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'message required' }));
                        return;
                    }

                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive',
                        'X-Accel-Buffering': 'no',
                    });

                    const write = (evt: Record<string, unknown>): void => {
                        res.write(`data: ${JSON.stringify(evt)}\n\n`);
                    };

                    try {
                        const cfg = configManager.read();
                        // V2.2 escalate path: if the client forced a
                        // specific provider for THIS call, use it; else
                        // honor the persistent config selection. Either
                        // way, emit the resolved provider so the UI can
                        // label the resulting bubble.
                        const resolvedProvider = forceProvider ?? cfg.llmProvider;
                        const key = await getApiKey(resolvedProvider);
                        write({ type: 'start', provider: resolvedProvider });

                        // V2.1: if the message references `[node:id]` markers
                        // (added by the "Ask about this" button on the node
                        // detail drawer), load those nodes + their immediate
                        // neighbors and prepend as a system-prompt addendum so
                        // the LLM answers in scope. Focus event still fires
                        // so the canvas pans to the primary reference.
                        let enrichedMessage = message;

                        // Phase 1 / C2 — collect each active plugin's system-
                        // prompt contribution and stash it to prepend below.
                        // Plugins teach the LLM about their domain (tone,
                        // vocabulary, when to call which tool). `llmStream`
                        // takes a single string; we fold the contributions
                        // into that string rather than using a separate
                        // 'system' role (local Qwen has no system role, and
                        // uniformity across providers is simpler).
                        const pluginPromptParts = pluginRegistry.getSystemPromptContributions({
                            graph,
                            verbatimStore,
                            syncEngine,
                            syncAdapter: adapter,
                            schemaLoader,
                            scope: detectedScope,
                            loreDir,
                        });
                        const markerRe = /\[node:([\w\-.:]+)\]/gi;
                        const referencedIds: string[] = [];
                        let m;
                        while ((m = markerRe.exec(message)) !== null) {
                            referencedIds.push(m[1]);
                        }
                        if (referencedIds.length > 0) {
                            // S7 — build wrapped <data> blocks for each
                            // referenced node and track any that scan as
                            // suspicious. The LLM is told upfront (via the
                            // hardened prefix) that <data> blocks carry
                            // untrusted content — instructions inside are
                            // to be refused.
                            const wrappedBlocks: string[] = [];
                            const suspicious: Array<{ source: string; patterns: string[] }> = [];
                            const chatCtx = graph.createPluginGraphContext();
                            for (const rawId of referencedIds) {
                                try {
                                    // V2.2 routing: three cases by marker prefix.
                                    //   1. "lore:<id>" or no prefix → core LoreNode table
                                    //   2. "<prefix>:<id>" where <prefix> is owned by a plugin
                                    //      (e.g. file:, symbol:) → plugin.resolveChatContext
                                    //   3. anything else → skip (fall-through for future plugins)
                                    const isCore = rawId.startsWith('lore:') || !rawId.includes(':');
                                    let rawBlock: string | null = null;
                                    let sourceTag = '';

                                    if (isCore) {
                                        const id = rawId.startsWith('lore:') ? rawId.slice(5) : rawId;
                                        const refNode = await graph.getNode(id);
                                        if (!refNode) continue;
                                        const outRows = await chatCtx.queryRows(
                                            `MATCH (n:LoreNode {id: $id})-[e:LoreEdge]->(m:LoreNode)
                                             RETURN m.id AS id, m.label AS label, m.type AS type, e.relation AS rel`,
                                            { id },
                                        ).catch(() => []);
                                        const inRows = await chatCtx.queryRows(
                                            `MATCH (m:LoreNode)-[e:LoreEdge]->(n:LoreNode {id: $id})
                                             RETURN m.id AS id, m.label AS label, m.type AS type, e.relation AS rel`,
                                            { id },
                                        ).catch(() => []);
                                        const neighborLines = [...outRows, ...inRows]
                                            .slice(0, 10)
                                            .map((r) => `  - ${r.rel ?? 'related_to'} → ${r.type}: ${r.label} (${r.id})`)
                                            .join('\n');
                                        rawBlock =
                                            `Label: ${refNode.label}\nType: ${refNode.type}\n\n` +
                                            `Content:\n${refNode.content || '(no content)'}\n\n` +
                                            `Connected to:\n${neighborLines || '  (no edges yet)'}`;
                                        sourceTag = `lore:${refNode.id}`;
                                    } else {
                                        // Plugin-owned marker. Iterate active plugins
                                        // and let the first one that recognizes the
                                        // prefix return the context block.
                                        for (const plugin of pluginRegistry.active()) {
                                            if (typeof plugin.resolveChatContext !== 'function') continue;
                                            const block = await plugin.resolveChatContext(rawId, chatCtx).catch(() => null);
                                            if (block) {
                                                const neighborLines = (block.neighbors ?? [])
                                                    .slice(0, 10)
                                                    .map((n) => `  - ${n.relation} → ${n.type}: ${n.label} (${n.id})`)
                                                    .join('\n');
                                                rawBlock =
                                                    `Label: ${block.label}\nType: ${block.type}\n\n` +
                                                    `Content:\n${block.content || '(no content)'}\n\n` +
                                                    `Connected to:\n${neighborLines || '  (no edges yet)'}`;
                                                sourceTag = rawId;
                                                break;
                                            }
                                        }
                                    }

                                    if (!rawBlock) continue;
                                    const wrapped = wrapUntrustedContent(rawBlock, sourceTag);
                                    wrappedBlocks.push(wrapped.wrapped);
                                    if (wrapped.scan.suspicious) {
                                        suspicious.push({
                                            source: sourceTag,
                                            patterns: wrapped.scan.patternsMatched,
                                        });
                                    }
                                } catch (refErr) {
                                    console.error(`[/api/chat] failed to load ref node ${redactId(rawId)}: ${redactError(refErr)}`);
                                }
                            }
                            if (wrappedBlocks.length > 0) {
                                const warning = buildInjectionWarning(suspicious);
                                const pieces = [
                                    hardenedSystemPrefix(),
                                    warning, // null-safe; filtered below
                                    'You are answering a question about knowledge nodes the user referenced. The retrieved context is enclosed in <data> blocks.',
                                    wrappedBlocks.join('\n\n'),
                                    '## User question',
                                    message,
                                ].filter((p): p is string => typeof p === 'string' && p.length > 0);
                                enrichedMessage = pieces.join('\n\n');
                                write({ type: 'focus', nodeId: referencedIds[0], matches: referencedIds });
                                if (suspicious.length > 0) {
                                    console.error(`[/api/chat] injection-scan flagged ${suspicious.length} retrieved block(s): ${suspicious.map((s) => s.patterns.join('+')).join(', ')}`);
                                }
                            }
                        } else {
                            // Fallback: regex-match tokens against node labels
                            // for camera pan (Phase 3 focus fallback).
                            try {
                                const topology = await graph.getTopology(500);
                                const tokens = message
                                    .toLowerCase()
                                    .split(/[^a-z0-9_\-:]+/i)
                                    .filter((t) => t.length >= 4);
                                const matches: string[] = [];
                                for (const node of topology.nodes) {
                                    const label = (node.label ?? node.id).toLowerCase();
                                    if (tokens.some((tok) => label.includes(tok))) {
                                        matches.push(node.id);
                                        if (matches.length >= 3) break;
                                    }
                                }
                                if (matches.length > 0) {
                                    write({ type: 'focus', nodeId: matches[0], matches });
                                }
                            } catch {
                                // Focus fallback is best-effort.
                            }
                        }

                        // Prepend plugin prompt contributions (C2). They go
                        // AFTER any [node:id] context we built above, so
                        // domain guidance frames how the LLM treats the
                        // referenced nodes. If no plugins contributed, this
                        // is a no-op.
                        if (pluginPromptParts.length > 0) {
                            const preamble = pluginPromptParts.join('\n\n');
                            enrichedMessage = `${preamble}\n\n---\n\n${enrichedMessage}`;
                        }

                        for await (const chunk of llmStream(resolvedProvider as LlmProvider, enrichedMessage, key)) {
                            if (chunk.kind === 'token' && chunk.content) {
                                write({ type: 'token', content: chunk.content });
                            } else if (chunk.kind === 'model_loading') {
                                // V2.1: first-run Qwen download progress.
                                write({
                                    type: 'model_loading',
                                    status: chunk.status,
                                    file: chunk.file,
                                    progress: chunk.progress,
                                });
                            } else if (chunk.kind === 'error') {
                                write({ type: 'error', message: chunk.message });
                            } else if (chunk.kind === 'done') {
                                write({ type: 'done' });
                            }
                        }
                    } catch (err) {
                        write({ type: 'error', message: `chat pipeline: ${(err as Error).message}` });
                    } finally {
                        res.end();
                    }
                });
                return;
            }

            // C6 — List pending approvals. UI "Pending actions" panel
            // polls or long-polls this. Entries live ~60s then auto-deny.
            if (pathname === '/api/approvals' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ pending: consentManager.list() }));
                return;
            }

            // C6 — Resolve a pending approval. POST body: {approved: boolean, reason?}
            if (url.startsWith('/api/approval/') && req.method === 'POST') {
                const id = url.slice('/api/approval/'.length);
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    try {
                        const payload = JSON.parse(body || '{}') as { approved?: boolean; reason?: string };
                        if (typeof payload.approved !== 'boolean') {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'approved must be boolean' }));
                            return;
                        }
                        const ok = consentManager.resolve(id, payload.approved, payload.reason);
                        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok, id }));
                    } catch (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // Phase 6 — Retention sweep trigger (dry-run by default).
            //   POST /api/retention/sweep {apply?: boolean, plugins?: string[]}
            // Applies are consent-gated because archive mutates node
            // content (replaces with placeholder + sourceRef).
            if (pathname === '/api/retention/sweep' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    const startMs = Date.now();
                    try {
                        const { apply, plugins } = JSON.parse(body || '{}') as {
                            apply?: boolean;
                            plugins?: string[];
                        };
                        let approvalId: string | undefined;
                        if (apply) {
                            const cReq = consentManager.request(
                                'retention.sweep.apply',
                                { plugins },
                                { context: 'Apply retention policy. Archives eligible node contents; for `delete` and `evict-content` actions, applied sweep currently defers to the consent-UI followup.' },
                            );
                            approvalId = cReq.id;
                            const decision = await cReq.wait;
                            if (!decision.approved) {
                                auditLog.log({
                                    toolName: 'retention.sweep',
                                    args: { apply, plugins },
                                    result: 'denied-by-user',
                                    resultDetail: decision.reason,
                                    approvalId,
                                    durationMs: Date.now() - startMs,
                                });
                                res.writeHead(403, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'consent denied', reason: decision.reason }));
                                return;
                            }
                        }
                        const result = await retentionSweeper.sweep({
                            dryRun: !apply,
                            plugins,
                            sink: archiveSink,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    } catch (err) {
                        auditLog.log({
                            toolName: 'retention.sweep',
                            args: {},
                            result: 'error',
                            resultDetail: (err as Error).message,
                            durationMs: Date.now() - startMs,
                        });
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: (err as Error).message }));
                    }
                });
                return;
            }

            // C12 — List retention rules contributed by active plugins.
            // Daily-sweep enforcement is a separate runtime (not in this
            // commit); exposing the rules now lets the UI show them and
            // catches plugin misconfigurations early.
            if (pathname === '/api/retention' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ rules: pluginRegistry.collectRetentionPolicies() }));
                return;
            }

            // C6b — External MCP client status.
            if (pathname === '/api/mcp-clients' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ clients: mcpClientRuntime.list() }));
                return;
            }

            // C6 — Audit log read surface.
            //   GET /api/audit?tail=N       last N entries (default 100)
            //   GET /api/audit?since=ISO    entries after timestamp
            if (url.startsWith('/api/audit') && req.method === 'GET') {
                try {
                    const parsed = new URL(url, 'http://localhost');
                    const since = parsed.searchParams.get('since');
                    const tailStr = parsed.searchParams.get('tail');
                    let entries;
                    if (since) {
                        entries = auditLog.since(since);
                    } else {
                        const n = tailStr ? parseInt(tailStr, 10) : 100;
                        entries = auditLog.tail(Number.isFinite(n) ? n : 100);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ entries, count: entries.length }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // C5 — Connector status. Lists registered connectors + last-
            // sync state. UI "Sources" panel will poll this.
            if (pathname === '/api/connectors' && req.method === 'GET') {
                try {
                    const status = connectorRegistry.listStatus();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ connectors: status }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // C8 — Static HTML export. Offline-viewable graph snapshot
            // via vis-network (CDN-loaded). Share the file; no Lore
            // daemon required on the viewer's machine.
            if (url.startsWith('/api/export/html') && req.method === 'GET') {
                try {
                    const parsed = new URL(url, 'http://localhost');
                    const project = parsed.searchParams.get('project') ?? undefined;
                    const maxNodes = parseInt(parsed.searchParams.get('maxNodes') ?? '500', 10);
                    const title = parsed.searchParams.get('title') ?? undefined;
                    // Q2.2 — HTML export reads the local graph directly; cloud-mode
                    // export is a slice-3 follow-up (needs Dataplane-native dump).
                    const html = await exportGraphAsHtml(graph as LocalGraph, {
                        project,
                        maxNodes: Number.isFinite(maxNodes) ? maxNodes : 500,
                        title,
                    });
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(html);
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // C4 — Graph report. Returns the full markdown digest so
            // the CLI can print/save it without needing its own Kùzu
            // connection (the daemon holds the single-writer lock).
            if (url.startsWith('/api/report') && req.method === 'GET') {
                try {
                    const parsed = new URL(url, 'http://localhost');
                    const project = parsed.searchParams.get('project') ?? undefined;
                    const topN = parseInt(parsed.searchParams.get('topN') ?? '20', 10);
                    // Q2.2 — report uses LocalGraph-native queries; cloud-mode
                    // report is a slice-3 follow-up.
                    const md = await writeGraphReport(graph as LocalGraph, {
                        project,
                        topN: Number.isFinite(topN) ? topN : 20,
                        registry: pluginRegistry,
                    });
                    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
                    res.end(md);
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // C3.5 + C5.5 — Storage inspection + quota decision per
            // workspace. UI reads both from one call so the Storage
            // panel can show usage + budget state without a second hop.
            if (pathname === '/api/storage' && req.method === 'GET') {
                try {
                    const dataHome = loreHome();
                    const workspaces = inspectAllWorkspaces(dataHome);
                    const home = inspectDataHome(dataHome);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        dataHome: {
                            path: dataHome,
                            breakdown: home,
                        },
                        workspaces: workspaces.map((w) => ({
                            name: w.name,
                            path: w.path,
                            breakdown: w.breakdown,
                            quota: decideQuota({ breakdown: w.breakdown }),
                        })),
                    }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
                return;
            }

            // Visualizer Frontend Endpoint
            if (pathname === '/explore' && req.method === 'GET') {
                try {
                    const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
                    // When running from dist/mcp, root is ../../
                    // When running from src/mcp, root is ../../ 
                    // Wait, from src/mcp, package root is ../../ as well. 
                    const htmlPath = path.resolve(__dirnameLocal, '../../src/public/explore.html');
                    const html = fs.readFileSync(htmlPath, 'utf8');
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(html);
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Failed to load explore HTML dashboard: ' + (err as Error).message);
                }
                return;
            }

            // Unknown path
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found. Use /mcp for MCP or /health for status.' }));
        });

        httpServer.listen(LORE_HTTP_PORT, '127.0.0.1', () => {
            console.error(`[Lore MCP] Server v1.0.0 started on HTTP :${LORE_HTTP_PORT}`);
            console.error(`[Lore MCP] Endpoint: http://127.0.0.1:${LORE_HTTP_PORT}/mcp`);
            console.error(`[Lore MCP] Health:   http://127.0.0.1:${LORE_HTTP_PORT}/health`);
            console.error(`[Lore MCP] Graph: ${path.join(graphBasePath, '.lore', 'graph')}`);
            console.error(`[Lore MCP] Scope: project=${detectedScope.project}, ecosystem=${detectedScope.ecosystem}`);
            console.error(`[Lore MCP] Engine: Kùzu (unified graph)`);
        });

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.error('[Lore MCP] Shutting down...');
            httpServer.close();
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            httpServer.close();
            process.exit(0);
        });
    } else {
        // stdio mode — backward compatible, one IDE per process
        const server = createMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);

        console.error(`[Lore MCP] Server v1.0.0 started on stdio.`);
        console.error(`[Lore MCP] Graph: ${path.join(graphBasePath, '.lore', 'graph')}`);
        console.error(`[Lore MCP] Scope: project=${detectedScope.project}, ecosystem=${detectedScope.ecosystem}`);
        console.error(`[Lore MCP] Engine: Kùzu (unified graph)`);
    }
}

main().catch((startupError) => {
    console.error('[Lore MCP] Failed to start:', startupError);
    process.exit(1);
});

