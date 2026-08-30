/**
 * services.ts — Pure factory functions for the daemon's service singletons.
 *
 * These were inline in server.ts; pulling them out shrinks the boot
 * file and keeps each factory's signature explicit (no module-scope
 * closure capture). Init *order* and the mutable singletons themselves
 * (graph, syncEngine, adapter, wal, dataplaneState) stay in server.ts —
 * those are tightly coupled to the keychain-upgrade flow and don't
 * make sense as standalone factories.
 */

// TW-1b: groundfloor-ts-sdk is an OPTIONAL, cloud-only dependency. Keep this a
// type-only import (erased at compile time, resolved against the dev-installed
// optional dep) so the local/embedded product never statically loads the SDK
// module. The actual class is loaded lazily via loadGroundfloorClient() inside
// the cloud branches only.
import * as path from 'node:path';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import { createTableStorage } from '../engines/tableStorageFactory.js';
import type { ISessionCache } from '../engines/sessionCache.js';
import { openWorkspaceGraph } from '../engines/openWorkspaceGraph.js';
import { requireWorkspaceGraph, isWorkspaceGraph } from '../engines/requireWorkspaceGraph.js';
import { collectSupersededEligible } from '../engines/nodePager.js';
import { hasCapability } from '../engines/connectorCapabilities.js';
import { DataplaneGraph } from '../engines/dataplaneGraph.js';
import { VerbatimStore } from '../engines/verbatimStore.js';
import type { PendingAutolinkTracker } from '../engines/pendingAutolink.js';
import { VerbatimSearchWorkerProxy, searchWorkerIsolationEnabled } from '../engines/verbatimSearchWorkerProxy.js';
import { DataplaneVectorStore } from '../engines/dataplaneVectorStore.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';
import { OpenAICompatEmbeddingProvider } from '../providers/openAICompatEmbeddingProvider.js';
import { TsSdkAdapter } from '../engines/tsSdkAdapter.js';
import type { TsSdkConfig } from '../engines/tsSdkAdapter.js';
import { resolveSyncAdapter } from '../engines/syncAdapterRegistry.js';
import { requireCurrentTenantId } from '../security/workspaceContext.js';
import type { AuditLog } from '../security/audit.js';
import {
    getActiveWorkspaceName,
    getWorkspaceRetention,
} from '../config/workspaces.js';
import { SchemaAuthoringStore } from '../schemas/authoring.js';
import { LocalGraphSnapshotter } from '../schemas/dataSnapshot.js';
import type { SchemaGraphOps } from '../schemas/substrate/schemaGraphOps.js';
import type { ITableStorage } from '../contracts/tables.js';
import { ClassificationAuditLogger } from '../security/classificationAudit.js';
import { SchemaChangeAuditLogger } from '../security/schemaChangeAudit.js';
import { LoreStorageClient } from '../storage/loreStorageClient.js';
import { ClassificationExceptionQueue } from '../security/classificationExceptionQueue.js';
import { SyncDirectionGuard } from '../security/syncDirectionGuard.js';
import { ConflictLog } from '../engines/multiMasterSync.js';
import { InMemoryPendingOpsStore } from '../security/inMemoryPendingOpsStore.js';
import { SqlitePendingOpsStore } from '../security/sqlitePendingOpsStore.js';
import type { PendingOpsStore } from '../security/pendingOps.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';

// cq-services-lore-graph-handle-duplicate — canonical home for the graph /
// vector substrate unions shared with server.ts (the two files central to the
// embeddable refactor). server.ts imports these instead of re-declaring them.
// (The broader 29-file alias proliferation is cq-lore-graph-alias-proliferation.)
// Widened for the Kùzu removal: naming the two CONCRETE classes silently
// excluded SurrealGraph (see engines/htmlExport.ts). Need more than the
// shared handle? Feature-detect and refuse — do not re-narrow to a class.
export type LoreGraph = LoreGraphHandle;
export type LoreVectorStore = VerbatimStore | DataplaneVectorStore;

/**
 * requireDataplaneOrgId — Cloud-mode tenant-isolation boot gate (D4/G14).
 *
 * In cloud/Dataplane mode the org id scopes every read and write. A
 * forgotten DATAPLANE_ORG_ID used to fall back to the literal 'default'
 * (six call sites), silently collapsing all tenants into one org — a
 * cross-tenant data-mixing risk that fails a multi-tenant security
 * review. There is no safe default in cloud mode, so refuse to build any
 * Dataplane-bound service without an explicit org id.
 *
 * Local mode never reaches this gate: it has no org and uses LocalGraph /
 * VerbatimStore, so its behaviour is unchanged.
 */
export function requireDataplaneOrgId(): string {
    const orgId = process.env['DATAPLANE_ORG_ID'];
    if (!orgId) {
        throw new Error(
            '[Lore MCP] DATAPLANE_ORG_ID is required in cloud mode but is unset. ' +
                'Refusing to start: a missing org id would silently collapse every ' +
                "tenant into one 'default' org (cross-tenant data mixing). Set " +
                'DATAPLANE_ORG_ID to the tenant org id, or run in local mode ' +
                '(unset LORE_DEPLOYMENT_MODE / set it to "local").',
        );
    }
    return orgId;
}

/**
 * loadGroundfloorClient — Lazy, cloud-only loader for the optional
 * groundfloor-ts-sdk dependency (TW-1b).
 *
 * The SDK is declared under package.json#optionalDependencies, so a
 * local/embedded consumer's `npm install` succeeds even when the SDK can't
 * be resolved. To keep the local path from ever touching the missing module,
 * the static import above is type-only (erased); the runtime class is pulled
 * in here via a dynamic import that ONLY executes inside the cloud branches.
 *
 * If the SDK isn't present (local install, optional dep skipped), surface a
 * clear, actionable error instead of a raw ERR_MODULE_NOT_FOUND.
 */
export async function loadGroundfloorClient(): Promise<typeof import('groundfloor-ts-sdk').GroundfloorClient> {
    try {
        const m = await import('groundfloor-ts-sdk');
        return m.GroundfloorClient;
    } catch (err) {
        throw new Error(
            "[Lore MCP] cloud mode requires the optional dependency 'groundfloor-ts-sdk' — " +
                "install it to use deploymentMode:'cloud'. " +
                `(dynamic import failed: ${(err as Error).message})`,
        );
    }
}

export interface CreateGraphOpts {
    deploymentMode: 'local' | 'cloud';
    graphBasePath: string;
    cacheTtlMs: number;
    cacheMaxSize: number;
    cacheDisabled: boolean;
    /**
     * The active workspace's name, when boot has already resolved one. Lets the
     * engine be resolved by NAME instead of by matching `graphBasePath` against
     * `workspaces.json`; the path match is the fallback and is what a bare
     * `--path` or a test temp dir gets.
     */
    workspaceId?: string;
    /**
     * LORE_HOME for the engine lookup. Passed explicitly because an embedded
     * host can run against a `dataDir` that is not the process-global
     * `LORE_HOME`; without it the workspace would not be found in
     * `workspaces.json` and would silently resolve to the default engine.
     */
    home?: string;
}

/**
 * createGraph — Mode-conditional graph factory.
 *
 *   local mode: the engine the ACTIVE WORKSPACE DECLARES, at its path.
 *   cloud mode: DataplaneGraph fronting groundfloor-ts-sdk. Every op
 *               reads the current workspace via AsyncLocalStorage
 *               (bindWorkspaceToRequest, set at the top of each HTTP
 *               request once the X-Lore-Workspace gate has passed).
 *
 * ── WHY THE LOCAL BRANCH IS NOT `new LocalGraph(...)` ANY MORE ──────────────
 *
 * It was, unconditionally, and that made the whole daemon Kùzu-only no matter
 * what a workspace declared. `graphEngine: 'surreal'` was reachable from the
 * CLI (`openWorkspaceGraph`) and from `lore migrate engine`
 * (`LocalGraphRegistry.getGraphHandle`) and from nowhere else — every daemon
 * read and write went to the real-but-EMPTY Kùzu database such a workspace
 * still carries, and returned success. This is the boot half of that fix; the
 * per-request half is every resolver moving from `getOrOpen` to
 * `getGraphHandle`.
 *
 * In cloud mode, the Dataplane credential is mandatory (Q2.1 boot gate
 * enforces this in main()). The keychain upgrade may replace this graph
 * in main() before any request lands; here we only need a key that
 * satisfies the GroundfloorClient constructor.
 */
export async function createGraph(opts: CreateGraphOpts): Promise<LoreGraph> {
    if (opts.deploymentMode === 'cloud') {
        const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
        const apiKey = process.env['DATAPLANE_API_KEY'] ?? '';
        const orgId = requireDataplaneOrgId();
        const GroundfloorClient = await loadGroundfloorClient();
        const client = new GroundfloorClient(baseUrl, apiKey || 'pending-keychain');
        return new DataplaneGraph({
            client,
            tenantProvider: () => requireCurrentTenantId(),
            orgId,
        });
    }
    // Construction only — `openWorkspaceGraph` deliberately does not
    // initialize, matching what `new LocalGraph(...)` did here before. Boot
    // owns the `initialize()` call, as it always has.
    return openWorkspaceGraph(opts.graphBasePath, {
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        ...(opts.home ? { home: opts.home } : {}),
        cacheTtlMs: opts.cacheTtlMs,
        cacheMaxSize: opts.cacheMaxSize,
        cacheDisabled: opts.cacheDisabled,
    });
}

/**
 * createEmbeddingProvider — Selects the embedding backend.
 *
 * Selection precedence (highest → lowest):
 *   1. LORE_EMBEDDING_PROVIDER=openai_compat → remote provider
 *      Requires LORE_EMBEDDING_BASE_URL, LORE_EMBEDDING_MODEL,
 *      LORE_EMBEDDING_DIMENSION. LORE_EMBEDDING_API_KEY optional.
 *   2. LORE_LOCAL_EMBEDDING_MODEL=<modelId> → local override
 *      Optional LORE_LOCAL_EMBEDDING_DIM (defaults to 384).
 *   3. (default) LocalEmbeddingProvider — Xenova/all-MiniLM-L6-v2.
 *
 * Reverted 2026-04-30: silent autodetection at boot was wrong design.
 * Embedder swaps belong in a deliberate `lore embedder switch` CLI
 * command (see commands.ts) that runs the migration as part of the swap.
 */
export async function createEmbeddingProvider(
    overrides?: import('../providers/localEmbeddingProvider.js').LocalEmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
    const providerKind = (process.env['LORE_EMBEDDING_PROVIDER'] ?? '').trim().toLowerCase();

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
    // v1.1 (deferred item #3): operator opt-in for the ONNX execution
    // provider. Accepts 'cpu' | 'coreml' | 'webgpu' | 'cuda' | 'auto'.
    // Verify availability via /health.embeddingBackend.providers before
    // setting — the actual list of compiled-in EPs varies by platform.
    const localDeviceRaw = (process.env['LORE_LOCAL_EMBEDDING_DEVICE'] ?? '').trim().toLowerCase();
    const validDevices = new Set(['cpu', 'coreml', 'webgpu', 'cuda', 'auto', 'gpu']);
    const localDevice = localDeviceRaw && validDevices.has(localDeviceRaw)
        ? (localDeviceRaw as 'cpu' | 'coreml' | 'webgpu' | 'cuda' | 'auto' | 'gpu')
        : undefined;
    if (localDeviceRaw && !localDevice) {
        console.error(
            `[Lore MCP] LORE_LOCAL_EMBEDDING_DEVICE=${localDeviceRaw} not recognised; ignoring (valid: ${Array.from(validDevices).join(', ')})`
        );
    }

    // Programmatic overrides (from createLore({ embedding: ... })) take
    // precedence over env vars for the local provider path.
    const effectiveDevice = overrides?.device ?? localDevice;
    const effectiveModelId = overrides?.modelId ?? (localModelOverride || undefined);
    const effectiveDtype = overrides?.dtype;

    if (effectiveModelId) {
        const dim = overrides?.dimension ?? (localDimRaw ? Number.parseInt(localDimRaw, 10) : undefined);
        if (localDimRaw && !overrides?.dimension && (!Number.isInteger(dim) || (dim ?? 0) <= 0)) {
            throw new Error(
                `[Lore MCP] LORE_LOCAL_EMBEDDING_DIM must be a positive integer (got ${JSON.stringify(localDimRaw)})`
            );
        }
        const provider = new LocalEmbeddingProvider({
            modelId: effectiveModelId,
            ...(dim ? { dimension: dim } : {}),
            ...(effectiveDevice ? { device: effectiveDevice } : {}),
            ...(effectiveDtype ? { dtype: effectiveDtype } : {}),
        });
        console.error(
            `[Lore MCP] Embedding provider: local override (model=${provider.modelId}, dim=${provider.dimension}${effectiveDevice ? `, device=${effectiveDevice}` : ''})`
        );
        return provider;
    }

    const provider = new LocalEmbeddingProvider({
        ...(effectiveDevice ? { device: effectiveDevice } : {}),
        ...(effectiveDtype ? { dtype: effectiveDtype } : {}),
    });
    console.error(
        `[Lore MCP] Embedding provider: local (model=${provider.modelId}, dim=${provider.dimension}${effectiveDevice ? `, device=${effectiveDevice}` : ''})`
    );
    return provider;
}

export interface CreateVectorStoreOpts {
    deploymentMode: 'local' | 'cloud';
    graphBasePath: string;
    embeddingProvider: EmbeddingProvider;
    embedOverrides?: Record<string, unknown>;
}

/**
 * createVectorStore — Mode-conditional vector-store factory.
 *
 *   local mode: embedded LanceDB VerbatimStore at the active workspace path.
 *   cloud mode: DataplaneVectorStore fronting groundfloor-ts-sdk's vector
 *               extension. Embedding stays local (same Xenova pipeline);
 *               only storage + similarity-search IO crosses to Dataplane.
 */
export async function createVectorStore(opts: CreateVectorStoreOpts): Promise<LoreVectorStore> {
    if (opts.deploymentMode === 'cloud') {
        const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
        const apiKey = process.env['DATAPLANE_API_KEY'] ?? '';
        const orgId = requireDataplaneOrgId();
        // Share the pattern with createGraph(): pending-keychain is a
        // placeholder satisfied by the same maybeUpgradeAdapterFromKeychain
        // rebuild when a keychain credential is present.
        const GroundfloorClient = await loadGroundfloorClient();
        const client = new GroundfloorClient(baseUrl, apiKey || 'pending-keychain');
        return new DataplaneVectorStore({
            client,
            tenantProvider: () => requireCurrentTenantId(),
            orgId,
            embeddingProvider: opts.embeddingProvider,
            // Bind a capability probe so bm25Search can skip the call
            // when no connector ranks. Falls open on probe failure.
            hasCapability: (capability: string) =>
                hasCapability(baseUrl, apiKey || 'pending-keychain', capability),
        });
    }
    // Opt-in worker-process isolation (LORE_SEARCH_WORKER, default off): run the
    // native LanceDB store in a child process so a native crash restarts a worker
    // instead of taking the host down. Child rebuilds its provider from env.
    if (searchWorkerIsolationEnabled()) {
        return new VerbatimSearchWorkerProxy(opts.graphBasePath, opts.embedOverrides, opts.embeddingProvider);
    }
    return new VerbatimStore(opts.graphBasePath, opts.embeddingProvider);
}

/**
 * resolveSyncAdapterFromEnv — Build a TsSdkAdapter from DATAPLANE_*
 * env vars. Returns null when DATAPLANE_API_KEY is not set.
 *
 * The keychain upgrade in main() may replace the result before any
 * sync runs; this is just the env-fallback baseline.
 */
export function resolveSyncAdapterFromEnv(
    deploymentMode: 'local' | 'cloud',
): TsSdkAdapter | null {
    const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
    const apiKey = process.env['DATAPLANE_API_KEY'];
    const tenantId = process.env['DATAPLANE_TENANT_ID'] ?? 'groundfloor_lore';

    if (!apiKey) return null;

    // Cloud mode requires an explicit org id (D4/G14 tenant isolation). Local
    // mode may carry a DATAPLANE_API_KEY for opportunistic ("local-sync") sync
    // but is never tenant-scoped, so it tolerates an absent org id and keeps the
    // pre-SW-05 boot behavior (default 'default'). This MUST mirror the sibling
    // gate in maybeUpgradeAdapterFromKeychain — otherwise a local/CI daemon that
    // sets the key without an org id crashes at startup (SW-05 review regression).
    const orgId =
        deploymentMode === 'cloud'
            ? requireDataplaneOrgId()
            : process.env['DATAPLANE_ORG_ID'] ?? 'default';

    // W4-DATAPLANE-CLEANUP / DEC-CONTRACT — select the sync adapter through
    // W0-SYNC-REGISTRY's named registry instead of hardcoding `new TsSdkAdapter`.
    // 'dataplane' is the production cloud sync path and the default
    // (cloud_invariant). A future adapter (e.g. 'git') registers itself with
    // the registry and becomes selectable by config WITHOUT touching this core
    // factory — the registry IS the extension seam. The 'dataplane' factory
    // constructs a TsSdkAdapter, so the cast back to the concrete type preserves
    // the existing return contract that server.ts's
    // `let adapter: TsSdkAdapter | null` and the keychain-upgrade path depend on.
    //
    // NB: the adapter name is a literal default, NOT a new module-eval env read.
    // resolveSyncAdapterFromEnv runs at server.ts module scope; reading a fresh
    // env var here would require allow-listing it in envScrub (SP-17). Threading
    // a configurable name is a follow-up that owns that allowlist change.
    const cfg: TsSdkConfig = { baseUrl, apiKey, tenantId, orgId };
    return resolveSyncAdapter('dataplane', cfg) as TsSdkAdapter;
}

export interface MaybeUpgradeAdapterDeps {
    deploymentMode: 'local' | 'cloud';
    loreDir: string;
    /** Read fresh — adapter and graph are `let`-mutable in server.ts. */
    getAdapter: () => TsSdkAdapter | null;
    getGraph: () => LoreGraph;
    /** Vector store for pulled-node mirror (Audit 2026-05-13). Immutable; passed straight through to SyncEngine. */
    verbatimStore: LoreVectorStore;
    /** Setters write back into server.ts module-scope `let` bindings. */
    setAdapter: (a: TsSdkAdapter) => void;
    setSyncEngine: (s: import('../engines/syncEngine.js').SyncEngine) => void;
    setWal: (w: import('../engines/syncEngine.js').WriteAheadLog) => void;
    setGraph: (g: LoreGraph) => void;
}

/**
 * maybeUpgradeAdapterFromKeychain — S9 keychain preference.
 *
 * Called exactly once at main() startup. If the keychain has a
 * 'dataplane' account, its password overrides any env-sourced key, and
 * we rebuild adapter + syncEngine + wal with the fresh credential.
 *
 * Keychain fetch is best-effort — failures (keytar unavailable, empty
 * entry) leave the env-sourced adapter in place. In cloud mode, the
 * keychain credential ALSO rebuilds the DataplaneGraph (so new requests
 * use the real key instead of the 'pending-keychain' placeholder).
 */
export async function maybeUpgradeAdapterFromKeychain(
    deps: MaybeUpgradeAdapterDeps,
): Promise<'keychain' | 'env' | 'none'> {
    const { getApiKey } = await import('../config/keychain.js');
    const { SyncEngine } = await import('../engines/syncEngine.js');

    const keychainKey = await getApiKey('dataplane');
    if (!keychainKey) {
        return deps.getAdapter() ? 'env' : 'none';
    }
    const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
    const tenantId = process.env['DATAPLANE_TENANT_ID'] ?? 'groundfloor_lore';
    // Cloud mode requires an explicit org id (D4/G14). Local mode keeps its
    // prior behaviour: it may carry a keychain dataplane key for opportunistic
    // sync but is never tenant-scoped, so it tolerates an absent org id.
    const orgId =
        deps.deploymentMode === 'cloud'
            ? requireDataplaneOrgId()
            : process.env['DATAPLANE_ORG_ID'] ?? 'default';
    const newAdapter = new TsSdkAdapter({ baseUrl, apiKey: keychainKey, tenantId, orgId });
    deps.setAdapter(newAdapter);
    // Sprint 14 — SyncEngine accepts the LoreGraph union; the prior
    // `as LocalGraph` cast lied about cloud-mode runtime. Pass the
    // graph through and let SyncEngine duck-type LocalGraph-only ops
    // internally (see SyncEngine.markSynced guard).
    const newSync = new SyncEngine(
        deps.getGraph(),
        deps.loreDir,
        deps.deploymentMode === 'cloud' ? null : newAdapter,
        deps.verbatimStore,
    );
    deps.setSyncEngine(newSync);
    deps.setWal(newSync.getWal());
    // Q2.2 — In cloud mode, keychain-sourced credential also upgrades
    // the DataplaneGraph's client. Rebuild the graph binding so new
    // requests use the real key instead of the 'pending-keychain' stub.
    if (deps.deploymentMode === 'cloud') {
        const GroundfloorClient = await loadGroundfloorClient();
        const newClient = new GroundfloorClient(baseUrl, keychainKey);
        const newGraph = new DataplaneGraph({
            client: newClient,
            tenantProvider: () => requireCurrentTenantId(),
            orgId,
        });
        deps.setGraph(newGraph);
    }
    return 'keychain';
}

/**
 * StorageBundle — Unified storage handle for tool/route/CLI deps.
 *
 * Bundles three things every code path may need:
 *   - sdk:          Dataplane SDK handle (GroundfloorClient) in CLOUD mode;
 *                   null in LOCAL mode. Local paths never touch it — they use
 *                   loreGraph/loreVerbatim/storageClient (DEC-CONTRACT).
 *   - loreGraph:    Lore-internal graph layer (LocalGraph in local mode,
 *                   DataplaneGraph in cloud mode). Hosts everything the SDK
 *                   doesn't expose: analytics, internal SDK, sync WAL, lifecycle,
 *                   plus Lore-specific ops (markStaleByTags, supersedeNode,
 *                   pruneInferredLoreEdges, addBidirectionalEdge, ...).
 *   - loreVerbatim: Lore-internal vector layer (VerbatimStore / DataplaneVectorStore).
 *                   Hosts BM25 search, tombstone, count — operations the
 *                   generic SDK vector.search doesn't cover.
 *
 * Phase 2 plumbs `StorageBundle` through dep surfaces in place of the old
 * `{graph, verbatimStore}` pair. Bodies that hit SDK ops use bundle.sdk;
 * bodies that hit Lore-internal ops use bundle.loreGraph / bundle.loreVerbatim.
 *
 * The engines (LocalGraph, VerbatimStore, etc.) are NOT migration scaffolding —
 * they are the legitimate Lore-internal layers. See
 * memory/project_local_groundfloor_client_phase1.md for the corrected end-state.
 */
export interface StorageBundle {
    /**
     * Dataplane SDK handle. Cloud mode: the real GroundfloorClient (used by
     * server.ts's cloud branch). Local mode: null — local speaks the
     * GraphProvider/VectorProvider contract directly (DEC-CONTRACT), so the
     * SDK-shaped local shim (LocalGroundfloorClient) was dead code and was
     * removed in W4-DATAPLANE-CLEANUP. Local call paths use loreGraph /
     * loreVerbatim / storageClient, never `sdk`.
     */
    sdk: GroundfloorClient | null;
    loreGraph: LoreGraph;
    loreVerbatim: LoreVectorStore;
    /** Hot-cache (recent-node LRU). File-backed under `.lore/hot_session.json`,
     *  mode-agnostic — both local and cloud daemons get the same persistence
     *  story. Local mode also has its own internal SessionCacheManager inside
     *  LocalGraph. TW-7e: local mode now REUSES the LocalGraph-owned manager
     *  (single owner, single writer to the file, flushed on dispose) rather
     *  than constructing a second one; cloud mode owns a standalone manager.
     *  Typed as the ISessionCache interface — both modes' consumers only need
     *  pushNode/getHotContext/flushNow. */
    sessionCache: ISessionCache;
    /**
     * Phase 2 item 4 — universal tabular CRUD surface used by the
     * `collection_*` MCP tools and `/v1/{collection}` REST routes.
     * Local mode = SqliteTableStorage, built from the workspace path.
     * Cloud mode = stub that throws "not yet implemented" until
     * `DataplaneTableStorage` lands. See docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md
     * + project_phase2_investigation_2026_05_15 for the rationale.
     */
    tableStorage: ITableStorage;
    /**
     * Workspace base path — the directory holding `.lore/`.
     *
     * Carried on the bundle so path-backed subsystems (the approval queue) can
     * be constructed WITHOUT a LocalGraph. `createPendingOpsStore` used to
     * reach `requireLocalGraph(...).getGraphContext().storage.getConnection()`
     * purely to obtain somewhere to persist, which made a Kùzu connection a
     * precondition for human approvals.
     */
    graphBasePath: string;
    /**
     * Sprint 15 — LoreStorageClient facade.
     *
     * 14-method swap point for cloud activation. Call sites should
     * prefer `bundle.storageClient.X(...)` over direct `bundle.loreGraph.X(...)`
     * for the wrapped methods (upsertNode, getNode, listNodes, search,
     * addEdge, getStats, getTopology, supersedeNode, markStaleByTags,
     * verbatimStore, verbatimSearch, verbatimCount, verbatimDelete,
     * verbatimBm25Search). The long-tail Lore-only ops still reach
     * through `bundle.loreGraph` until a follow-up sprint expands the
     * facade. See DATAPLANE_INTEGRATION.md Section 10 item #2.
     */
    storageClient: LoreStorageClient;
    /**
     * This instance's in-flight INGEST-TIME autolink registry.
     *
     * Lives on the bundle because the bundle is what "one Lore instance" means
     * in practice: it is built once per `createLore()` and is threaded to every
     * surface that fires the autolink hook AND to the ordered shutdown drain. A
     * module-global registry — the first cut — made instance A's dispose()
     * wait on instance B's autolinks, so a hook wedged in B could hold A open.
     *
     * The hook-firing surfaces are exactly `mcp/bulkIngest.ts`, `mcp/server.ts`
     * (×2 embedded wrappers), `mcp/tools/memory/storeNode.ts` and the HTTP
     * route `http/routes/nodes/postNode.ts` (`grep -n 'autolink:'
     * packages/lore/src`), plus `engines/v1Migration.ts` which registers
     * directly. All four write surfaces build their handles through
     * core/nodeService.resolveAutolinkHandles (2026-08-19, launch-readiness
     * item 4) — before the 22c428e fix postNode fired NO autolink at all, and
     * an earlier version of this comment still said so, overstating the gap in
     * the one place coverage is the whole point.
     *
     * See engines/pendingAutolink.ts.
     */
    autolinkTracker: PendingAutolinkTracker;
    /**
     * This instance's in-flight LONG-SWEEP registry — the operator-initiated
     * `/api/graph/reconnect` + `/api/graph/reconsume` rebuilds.
     *
     * Deliberately NOT `autolinkTracker`. Those sweeps run for minutes; ingest
     * autolink hooks run for well under a second. Sharing one queue meant the
     * sweeps could never drain inside the ingest deadline (so the drain timed
     * out and closed the substrates underneath them), the timeout message
     * described the wrong workload, and every shutdown overlapping a sweep
     * stalled for the full ingest budget. Two workloads, two deadlines. See
     * DEFAULT_SWEEP_DRAIN_TIMEOUT_MS.
     */
    sweepTracker: PendingAutolinkTracker;
    deploymentMode: 'local' | 'cloud';
}



/**
 * createPendingOpsStore — HITL second-party-approval queue.
 *
 * Local mode: SqlitePendingOpsStore, persisted at
 * `.lore/pending-ops.sqlite`. Survives daemon restarts. Schema is created
 * in the constructor (idempotent `CREATE TABLE IF NOT EXISTS`).
 *
 * Cloud mode: InMemoryPendingOpsStore as a placeholder. The persistent
 * Postgres-via-Dataplane impl is a separate Bucket-B/C work item and
 * will land alongside the rest of the cloud-side approval surface.
 *
 * Routes + the approvalEnforcer depend only on the `PendingOpsStore`
 * interface, so flipping the cloud impl later is a one-liner here
 * with no caller changes.
 */
export function createPendingOpsStore(bundle: StorageBundle): PendingOpsStore {
    if (bundle.deploymentMode === 'cloud') {
        return new InMemoryPendingOpsStore();
    }
    // Local mode: its own SQLite file under the workspace's `.lore/`. The
    // queue is row-shaped and never stored an edge, so the Kùzu node table it
    // used to live in bought it nothing — while making a Kùzu connection a
    // precondition for approving anything.
    return new SqlitePendingOpsStore(path.join(bundle.graphBasePath, '.lore', 'pending-ops.sqlite'));
}

export type DataplaneState = 'unknown' | 'offline' | 'opted-out' | 'bound' | 'error';

export interface FireBootHealthPingDeps {
    /** Read fresh — adapter is `let`-mutable, replaced post-keychain-upgrade. */
    getAdapter: () => TsSdkAdapter | null;
    /** Read config.telemetryOptOut. */
    configManager: import('../config/configManager.js').ConfigManager;
    /** Caller writes the resulting state into its module-scope `let dataplaneState`. */
    setState: (s: DataplaneState) => void;
}

/**
 * fireBootHealthPing — Phase 4: Lightweight Dataplane health-ping.
 *
 * Invariants:
 *   - Fires exactly once at boot.
 *   - Sends NO graph contents, NO node counts, NO user data. Just
 *     "is the tenant reachable". Matches Non-Goal #4.
 *   - Honors config.telemetryOptOut. When true, skips the ping and
 *     treats dataplane as 'opted-out'.
 *   - Failure is non-fatal. Airplane-mode boot must succeed even when
 *     /etc/hosts points Dataplane at a black hole.
 */
export async function fireBootHealthPing(deps: FireBootHealthPingDeps): Promise<void> {
    try {
        const cfg = deps.configManager.read();
        if (cfg.telemetryOptOut) {
            deps.setState('opted-out');
            console.error('[Lore MCP] Dataplane ping: opted-out (config.telemetryOptOut=true)');
            return;
        }
        const adapter = deps.getAdapter();
        if (!adapter) {
            deps.setState('offline');
            console.error('[Lore MCP] Dataplane ping: offline (no dataplane credential in keychain or DATAPLANE_API_KEY env)');
            return;
        }
        // Q1.1 — verify the tenant is actually reachable, not just that
        // the SDK client constructed. GroundfloorClient() is a local
        // object instantiation; it does not hit the network. Lightweight
        // GET /health (matches the Dataplane's unauth health endpoint
        // shipped 2026-04-22). 2-second timeout so daemon boot never
        // stalls on a slow remote.
        await adapter.connect();
        const baseUrl = process.env['DATAPLANE_URL'] ?? 'http://localhost:8080';
        const controller = new AbortController();
        // TW-7e — boot health-ping timeout is env-overridable. Default 2000ms
        // keeps the prior behavior; a slow but reachable remote can widen it
        // without a recompile. Positive integer; invalid/absent → 2000.
        const healthTimeoutRaw = Number(process.env['LORE_DATAPLANE_HEALTH_TIMEOUT_MS']);
        const healthTimeoutMs = Number.isFinite(healthTimeoutRaw) && healthTimeoutRaw > 0 ? healthTimeoutRaw : 2000;
        const timer = setTimeout(() => controller.abort(), healthTimeoutMs);
        try {
            const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
                method: 'GET',
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`/health returned HTTP ${res.status}`);
            }
            deps.setState('bound');
            console.error('[Lore MCP] Dataplane ping: bound');
        } finally {
            clearTimeout(timer);
        }
    } catch (err) {
        deps.setState('error');
        console.error(`[Lore MCP] Dataplane ping: failed (${(err as Error).message}) — continuing offline`);
    }
}

export interface RunRetentionSweepDeps {
    graph: LoreGraph;
    verbatimStore: LoreVectorStore;
    auditLog: AuditLog;
    /** Workspace `graph`/`verbatimStore` were opened for (governs the policy read); optional only for the boot sweep. HTTP callers MUST pass it. */
    workspace?: string;
}

export interface RetentionSweepReport {
    policy: { autoArchiveSupersededAfterDays: number | null };
    eligible: number;
    archived: number;
    sample: Array<{ id: string; supersededAt: string }>;
    dryRun: boolean;
}

/**
 * runRetentionSweep — Walk every superseded node in `deps.workspace` (else
 * active workspace — boot sweep only) and tombstone the verbatim row once
 * supersededAt exceeds its auto-archive threshold. Trusts `deps.graph`/
 * `verbatimStore` are already opened for `deps.workspace`. Skips silently
 * when autoArchiveSupersededAfterDays is null/0/<0.
 */
export async function runRetentionSweep(
    deps: RunRetentionSweepDeps,
    dryRun: boolean,
): Promise<RetentionSweepReport> {
    const policy = getWorkspaceRetention(deps.workspace ?? getActiveWorkspaceName());
    const threshold = policy.autoArchiveSupersededAfterDays ?? 0;
    if (threshold <= 0) {
        return { policy: { autoArchiveSupersededAfterDays: null }, eligible: 0, archived: 0, sample: [], dryRun };
    }
    const cutoff = Date.now() - threshold * 24 * 60 * 60 * 1000;
    // Tombstones LanceDB-backed VerbatimStore rows; no DataplaneVectorStore
    // parity yet (Bucket B/C follow-up), so skip cleanly for the cloud adapter
    // rather than crashing — the empty report is the operator-visible signal.
    //
    // Capability probe, NOT `isLocalGraph`: the class check returned false for
    // a SurrealGraph, so once the daemon started resolving declared engines a
    // Surreal-backed workspace got that same empty report — reported as clean,
    // for a store nobody had looked at.
    if (!isWorkspaceGraph(deps.graph)) {
        return { policy: { autoArchiveSupersededAfterDays: threshold }, eligible: 0, archived: 0, sample: [], dryRun };
    }
    const localGraph = requireWorkspaceGraph(deps.graph, 'retention_sweep', 'verbatim tombstone path');
    // P1 scale fix — page the walk projecting only id + supersededAt (no
    // content); collect just the eligible {id, supersededAt}. Peak heap is one
    // page, not the whole node table with full content (OOM near ~1M nodes).
    const eligible = await collectSupersededEligible(
        localGraph.bulkListProjected.bind(localGraph), cutoff,
    );
    const sample = eligible.slice(0, 10).map((n) => ({ id: n.id, supersededAt: n.supersededAt }));
    let archived = 0;
    let archiveFailed = 0;
    if (!dryRun) {
        const store = deps.verbatimStore as unknown as { tombstone?: (id: string, reason: string) => Promise<void> };
        if (typeof store.tombstone === 'function') {
            for (const n of eligible) {
                // 1.M10 — tombstone() now THROWS on real failures (was a
                // bare catch swallow). Isolate per row so one failure
                // neither aborts the sweep nor reads as success.
                try {
                    await store.tombstone(`lore:${n.id}`, `auto-archived per workspace policy (>${threshold}d superseded)`);
                    archived++;
                } catch (err) {
                    archiveFailed++;
                    console.error(`[Lore] auto-archive tombstone failed for ${n.id}: ${(err as Error).message}`);
                }
            }
        }
        deps.auditLog.log({
            toolName: 'workspace.retention.sweep',
            args: { threshold, eligible: eligible.length },
            result: archiveFailed > 0 ? 'error' : 'success',
            resultDetail: `archived=${archived}${archiveFailed > 0 ? ` failed=${archiveFailed}` : ''}`,
            durationMs: 0,
        });
    }
    return {
        policy: { autoArchiveSupersededAfterDays: threshold },
        eligible: eligible.length,
        archived,
        ...(archiveFailed > 0 ? { failed: archiveFailed } : {}),
        sample,
        dryRun,
    };
}

export interface PhaseAServices {
    schemaAuthoring: SchemaAuthoringStore;
    classificationAudit: ClassificationAuditLogger;
    schemaChangeAudit: SchemaChangeAuditLogger;
    exceptionQueue: ClassificationExceptionQueue;
    syncGuard: SyncDirectionGuard;
    conflictLog: ConflictLog;
}

/**
 * createPhaseAServices — Instantiate the 6 Phase A.5 security/governance
 * singletons. All are filesystem-backed (JSONL under loreDir) except
 * SyncDirectionGuard (in-memory registry).
 *
 * Phase 1 item 3: when a `graph` is supplied, SchemaAuthoringStore is
 * wired with a `LocalGraphSnapshotter` so destructive approvals
 * capture the affected data to .lore/data-snapshots/ before flipping
 * the live schema. Tests + cloud-mode boots that don't need the
 * snapshotter pass `graph: undefined` and the store falls back to
 * the no-op snapshotter (existing behavior).
 */
export function createPhaseAServices(
    loreDir: string,
    graphBasePath: string,
    graph?: SchemaGraphOps,
): PhaseAServices {
    const schemaChangeAudit   = new SchemaChangeAuditLogger(loreDir);
    const snapshotter         = graph ? new LocalGraphSnapshotter(graph) : undefined;
    // Phase 3 item 1 — same GraphReader threaded into SchemaAuthoringStore
    // so propose() can compute blast radius at the moment a change is
    // submitted. Best-effort: a missing/throwing graph just omits the
    // blastRadius field on the SandboxEntry.
    const schemaAuthoring     = new SchemaAuthoringStore(graphBasePath, schemaChangeAudit, snapshotter, graph);
    const classificationAudit = new ClassificationAuditLogger(loreDir);
    const exceptionQueue      = new ClassificationExceptionQueue(loreDir);
    const syncGuard           = new SyncDirectionGuard();
    const conflictLog         = new ConflictLog(loreDir);
    return { schemaAuthoring, classificationAudit, schemaChangeAudit, exceptionQueue, syncGuard, conflictLog };
}
