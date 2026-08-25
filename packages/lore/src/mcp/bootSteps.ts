/**
 * bootSteps.ts — Self-contained boot lifecycle steps invoked from main().
 *
 * Each function wraps one bounded boot concern with the same try/catch
 * non-fatal pattern (the daemon must boot in airplane mode even when
 * individual steps fail). They live here rather than in services.ts
 * because they're orchestration glue — sequencing + error tolerance
 * around imperative side-effects — not pure factories.
 */

import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import { SyncEngineRegistry } from '../engines/syncEngineRegistry.js';
import type { SyncEngine } from '../engines/syncEngine.js';
import type { TsSdkAdapter } from '../engines/tsSdkAdapter.js';
import type { OutboxStore } from '../outbox/types.js';
import type { WorkspaceVerbatimResolver } from '../outbox/workspaceVerbatimResolver.js';
import { loreHome, loreHomePath } from '../config/loreHome.js';
import { getActiveWorkspacePath, getActiveWorkspaceName } from '../config/workspaces.js';
import { assertPathAllowed, PathAllowlistError, loadAllExtraRoots, type AllowlistConfig } from '../security/pathAllowlist.js';
import {
    readWorkspaceRegistry,
    migrateProjectsJsonToWorkspacesJson,
} from '../config/workspaceRegistry.js';
import { LocalSourceWatcher } from '../engines/localSourceWatcher.js';
import { buildVerbatimText } from '../engines/verbatimStore.js';
import { sweepFreshness, type IFreshnessGraph } from '../engines/freshnessEngine.js';
import { log } from '../logger.js';
import { KuzuSchemaGraphOps, type SchemaGraphOps } from '../schemas/substrate/schemaGraphOps.js';
import { resolveWorkspaceGraphEngine, GraphSubstrateUnsupportedError } from '../engines/graphEngineSelector.js';
import type { LoreGraphHandle } from '../storage/loreStorageClient.js';
import { isWorkspaceGraph } from '../engines/requireWorkspaceGraph.js';
import type { WorkspaceGraph } from '../engines/openWorkspaceGraph.js';

export interface ResolvedScope {
    workspace: string;
    ecosystem: string;
}

/**
 * resolveWorkspaceScope — Detects workspace/ecosystem from CWD.
 *
 * Matches process.cwd() against path fragments in the registry.
 * Returns {workspace: '*', ecosystem: '*'} if no match.
 *
 * The on-disk registry file still uses `projects` as its top-level
 * key (legacy schema; renaming would break user data). This function
 * normalises that into the canonical `workspace` field.
 *
 * TW-2a — accepts an optional `home` for signature symmetry with
 * {@link resolveGraphPath}. The CWD→workspace-name map
 * (`workspace-paths.json`) is process-global and only yields a workspace
 * NAME, never an on-disk write path; the instance-scoped on-disk graph is
 * resolved by `resolveGraphPath(home)` / `getActiveWorkspacePath(home)`.
 * A fresh per-instance `dataDir` simply has no CWD mapping and resolves to
 * `'*'`, which `resolveGraphPath(home)` then anchors under that home. The
 * param is therefore accepted but not consulted here (no isolation gap).
 */
export function resolveWorkspaceScope(_home?: string): ResolvedScope {
    const currentWorkingDirectory = process.cwd();
    const registry = readWorkspaceRegistry();
    // Defensive: readWorkspaceRegistry already normalises shape, but
    // guard against a future caller passing a hand-rolled object so
    // boot never crashes on a malformed registry.
    const projects = (registry && typeof registry.projects === 'object' && registry.projects)
        ? registry.projects
        : {};

    for (const [workspaceName, mapping] of Object.entries(projects)) {
        for (const pathFragment of mapping.paths) {
            if (currentWorkingDirectory.includes(pathFragment)) {
                return { workspace: workspaceName, ecosystem: mapping.ecosystem };
            }
        }
    }

    return { workspace: '*', ecosystem: '*' };
}

/**
 * runWorkspaceRegistryMigration — Phase 1 item 13. Best-effort one-
 * time copy of `projects.json` → `workspace-paths.json` at boot.
 * Logs the outcome but never throws — if the migration fails, the
 * registry reader silently falls back to the legacy file so the
 * daemon still boots.
 */
export function runWorkspaceRegistryMigration(): void {
    try {
        const result = migrateProjectsJsonToWorkspacesJson();
        if (result.migrated) {
            log.info('[Lore MCP] Migrated projects.json → workspace-paths.json (Phase 1 item 13)');
        }
    } catch (err) {
        log.error(`[Lore MCP] workspace-paths.json migration failed (non-fatal): ${(err as Error).message}`);
    }
}

/**
 * resolveGraphPath — Determines where the .lore/ graph directory lives.
 *
 * V2.1: the graph lives under the currently-active workspace. On first
 * boot, loadWorkspaces() auto-writes a "default" entry pointing at
 * ~/.groundfloor — preserving V2.0 data without migration. Subsequent
 * workspaces are created under ~/.groundfloor/workspaces/{name}/.
 *
 * TW-2a — `home` threads the per-instance Lore data root from
 * `createLore({dataDir})` through `getActiveWorkspacePath(home)` so two
 * embedded instances with distinct `dataDir` open disjoint on-disk graphs
 * instead of both falling back to the process-global LORE_HOME. Defaults
 * to `loreHome()` (env), preserving the daemon path byte-for-byte.
 */
export function resolveGraphPath(home: string = loreHome()): string {
    try {
        return getActiveWorkspacePath(home);
    } catch (err) {
        log.error(`[Lore MCP] Workspace resolve failed (${(err as Error).message}); falling back to ${home}`);
        return home;
    }
}
import type { VerbatimStore } from '../engines/verbatimStore.js';
import type { McpClientRuntime } from '../engines/mcpClient/runtime.js';
import { scrubEnv } from '../security/envScrub.js';
import { lockDownDataDir } from '../security/permissions.js';
import { rotateStandardLogs, rotateWorkspaceDispatchLog } from '../security/logRotator.js';
import { maybeRunBackgroundReconnect } from '../engines/backgroundReconnect.js';

/**
 * S9 — Parent environment scrub. Module-level env reads (DATAPLANE_*,
 * LORE_PORT) already captured whatever they needed from the inherited
 * env during import. After this call, process.env contains only the
 * allowlist — any subsequent env read inside Lore (or an extension) can't
 * surface an AWS/GitHub/etc. token the IDE happened to have set.
 */
export function runEnvScrub(): void {
    try {
        const scrub = scrubEnv();
        if (scrub.droppedCount > 0) {
            log.error(`[Lore MCP] Env scrub: dropped ${scrub.droppedCount} var(s); kept ${scrub.kept.length}. Sample dropped (non-secret names): ${scrub.droppedSamples.join(', ') || '(all names contained secret-like tokens; none safe to log)'}`);
        }
    } catch (scrubErr) {
        log.error(`[Lore MCP] Env scrub failed (non-fatal): ${(scrubErr as Error).message}`);
    }
}

/**
 * S1 — File permission lockdown (Phase 0 security hardening). Tighten
 * ~/.groundfloor (data home) AND the active workspace root if it
 * differs (custom workspace paths can live anywhere). Must run before
 * graph.initialize() so Kùzu files inherit the 0700 parent dir.
 */
export function runPermLockdown(graphBasePath: string): void {
    try {
        const dataHome = loreHome();
        const lockedPaths = new Set<string>([dataHome]);
        if (graphBasePath !== dataHome) lockedPaths.add(graphBasePath);
        for (const root of lockedPaths) {
            const summary = lockDownDataDir(root);
            const touched = summary.directoriesFixed + summary.filesFixed;
            if (touched > 0 || summary.errors.length > 0) {
                log.error(
                    `[Lore MCP] Perm lockdown ${root}: dirs=${summary.directoriesFixed} files=${summary.filesFixed} skipped=${summary.skipped} errors=${summary.errors.length}`,
                );
                for (const err of summary.errors) log.error(`[Lore MCP]   ${err}`);
            }
        }
    } catch (lockErr) {
        log.error(`[Lore MCP] Perm lockdown failed (non-fatal): ${(lockErr as Error).message}`);
    }
}

/**
 * C6b — connect to configured external MCP servers. Fire-and-forget so
 * a slow stdio spawn doesn't block daemon boot.
 */
export function startExternalMcpClients(mcpClientRuntime: McpClientRuntime): void {
    void mcpClientRuntime.connectAll().then((summary) => {
        if (summary.attempted > 0) {
            log.error(`[Lore MCP] External MCP clients: ${summary.connected}/${summary.attempted} connected (${summary.errored} errored)`);
        }
    }).catch((err) => {
        log.error(`[Lore MCP] MCP client runtime init failed: ${(err as Error).message}`);
    });
}

/**
 * F3 (Phase 7a) — rotate standard logs if they've exceeded size or age
 * thresholds. Runs AFTER S1 lockdown (perms are already tight) but
 * BEFORE any daemon-initiated logging gets serious volume for this
 * session. Non-fatal — rotation failures log to stderr and daemon
 * proceeds.
 */
export function runLogRotation(): void {
    try {
        const dataHome = loreHome();
        const results = rotateStandardLogs(dataHome);
        for (const r of results) {
            if (r.result.rotated) {
                log.error(
                    `[Lore MCP] Rotated ${path.basename(r.path)}: ` +
                    `${r.result.beforeBytes} bytes → ${r.result.rotatedTo} ` +
                    `(${r.result.reason}; retained ${r.result.retained}, deleted ${r.result.deleted})`,
                );
            }
        }
    } catch (rotErr) {
        log.error(`[Lore MCP] Log rotation failed (non-fatal): ${(rotErr as Error).message}`);
    }
}

/**
 * runWorkspaceLogRotation — rotate the workspace-scoped tool-dispatch log.
 * Called after workspace detection (once `loreDir` is known) so the correct
 * `.lore/` path is available. Non-fatal: failures log to stderr.
 */
export function runWorkspaceLogRotation(loreDir: string): void {
    try {
        const r = rotateWorkspaceDispatchLog(loreDir);
        if (r.result.rotated) {
            log.error(
                `[Lore MCP] Rotated ${path.basename(r.path)}: ` +
                `${r.result.beforeBytes} bytes → ${r.result.rotatedTo} ` +
                `(${r.result.reason}; retained ${r.result.retained}, deleted ${r.result.deleted})`,
            );
        }
    } catch (err) {
        log.error(`[Lore MCP] Workspace log rotation failed (non-fatal): ${(err as Error).message}`);
    }
}

export interface FileWatcherStartupDeps {
    graph: LoreGraphHandle;
    /**
     * Optional. When provided, auto-ingested file changes are also stored
     * in the vector store for semantic recall. Leave unset to skip embedding
     * (graph write still happens; embedding can be backfilled later).
     */
    verbatimStore?: VerbatimStore | null;
}

/**
 * Local-source-watcher pipeline: wire auto-ingestion of LORE_WATCH_PATHS
 * files AFTER the graph schema is initialized so writes can land in the
 * graph. Failures are non-fatal.
 *
 * Gated on the LOCAL ENGINE capability, not on the Kùzu class. The old
 * `deps.graph instanceof LocalGraph` was written when local mode could only
 * mean Kùzu; once `createGraph` started honouring the workspace's declared
 * engine it would have silently stopped watching files on a Surreal-backed
 * workspace — or, worse, kept watching and written the ingested content into
 * the empty Kùzu database the old boot graph pointed at.
 */
export async function startFileWatcher(deps: FileWatcherStartupDeps): Promise<void> {
    if (isWorkspaceGraph(deps.graph)) {
        const workspace = getActiveWorkspaceName();
        await startLocalSourceWatcher(
            makeFileIngestCallback(deps.graph, workspace, deps.verbatimStore ?? null),
        );
    }
}

export interface BackgroundReconnectDeps {
    loreDir: string;
    graph: WorkspaceGraph;
    verbatim: VerbatimStore;
    /** The booting instance's `StorageBundle.sweepTracker`. Threaded so the
     *  first-install sweep is per-instance, seal-gated and cooperatively
     *  abortable — see engines/backgroundReconnect.ts. */
    tracker?: import('../engines/pendingAutolink.js').PendingAutolinkTracker;
}

/**
 * v1.1 background first-install reconnect (2026-04-30): if the
 * workspace's reconnect.cursor is missing (= fresh install), kick off a
 * one-shot reconnect in the background so the daemon can start serving
 * requests immediately while embeddings + cross-pillar edges populate.
 * Skipped in cloud mode (Dataplane-side reconnect lands in a later
 * slice). Status is surfaced on /health + /api/health.
 */
export async function runBackgroundReconnectIfFresh(deps: BackgroundReconnectDeps): Promise<void> {
    try {
        await maybeRunBackgroundReconnect({
            loreDir: deps.loreDir,
            graph: deps.graph,
            verbatim: deps.verbatim,
            ...(deps.tracker ? { tracker: deps.tracker } : {}),
        });
    } catch (bgErr) {
        log.error(`[Lore MCP] background-reconnect schedule failed (non-fatal): ${(bgErr as Error).message}`);
    }
}


/** Hard cap on auto-ingested file content (prevents graph bloat / LLM waste). */
const MAX_AUTO_INGEST_BYTES = 512 * 1024; // 512 KB

/**
 * Debounce state for the post-ingest freshness sweep.
 * Sweeping on every file save is expensive (lists all nodes). We run at
 * most once per SWEEP_DEBOUNCE_MS across all ingest callbacks.
 */
const SWEEP_DEBOUNCE_MS = 60 * 60 * 1000; // 1 hour
let _lastSweepMs = 0;

/**
 * makeFileIngestCallback — Build an auto-ingest callback for LocalSourceWatcher.
 *
 * On each file change the callback:
 *   1. Reads the file (capped at 512 KB to prevent graph bloat).
 *   2. Upserts a `note` node with a deterministic ID derived from the
 *      file path — so rapid saves converge to a single node, not duplicates.
 *   3. If a `verbatimStore` is provided, also stores the embedding so the
 *      node is immediately searchable via semantic recall.
 *   4. Runs a debounced freshness sweep (at most once per hour) so local-
 *      only workspaces without cloud sync still surface accurate freshness
 *      percentages in /api/workspaces/:name/freshness.
 *
 * All errors are logged only — the daemon never crashes on a bad file read.
 *
 * @param graph          - LocalGraph instance (open, single-writer).
 * @param workspace      - Active workspace name; used as the node's `project`.
 * @param verbatimStore  - Optional. When provided, auto-ingest also writes
 *                         an embedding for immediate semantic recall.
 */
export function makeFileIngestCallback(
    graph: WorkspaceGraph,
    workspace: string,
    verbatimStore?: VerbatimStore | null,
    // audit 2026-06-25 (re-audit) — injectable allowlist so the path gate is
    // testable; defaults to the same production loader the other ingestion
    // paths use (active workspace root + ingestion.json / LORE_WATCH_PATHS).
    allowlist?: AllowlistConfig,
): (filePath: string) => void {
    return (filePath: string): void => {
        void (async () => {
            try {
                // audit 2026-06-25 (re-audit, security) — the auto-ingest watcher
                // is an ingestion entry point too: gate it through the SAME
                // path-allowlist the MCP tool + /api/ingest routes use, so a
                // symlink in a watched dir (e.g. notes.md -> ~/.ssh/id_rsa)
                // cannot be realpath-followed into a blocklisted root and stored
                // /embedded. Read the resolved (realpath'd) path to also close the
                // check->read TOCTOU. Refusals are logged, not fatal.
                let resolvedPath: string;
                try {
                    resolvedPath = assertPathAllowed(filePath, allowlist ?? {
                        workspaceRoot: getActiveWorkspacePath(),
                        extraRoots: loadAllExtraRoots(loreHome()),
                    });
                } catch (err) {
                    if (err instanceof PathAllowlistError) {
                        log.warn(`[auto-ingest] refused ${path.basename(filePath)}: ${err.message}`);
                        return;
                    }
                    throw err;
                }
                const raw = fs.readFileSync(resolvedPath, 'utf-8');
                const content = raw.length > MAX_AUTO_INGEST_BYTES
                    ? raw.slice(0, MAX_AUTO_INGEST_BYTES) + '\n[truncated by auto-ingest cap]'
                    : raw;
                const hash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 12);
                const nodeId = `file:${hash}`;
                const label = path.basename(filePath);

                await graph.upsertNode({
                    id: nodeId,
                    type: 'note',
                    label,
                    content,
                    tags: ['local-file', 'auto-ingested'],
                    project: workspace,
                    ecosystem: '*',
                    metadata: JSON.stringify({
                        sourcePath: filePath,
                        ingestedAt: new Date().toISOString(),
                    }),
                });

                // Mirror to vector store when available so the node is
                // immediately reachable via semantic recall.
                if (verbatimStore) {
                    try {
                        await verbatimStore.store({
                            id: `lore:${nodeId}`,
                            text: buildVerbatimText(label, content, 'local-file,auto-ingested'),
                            metadata: { type: 'note', label, tags: 'local-file,auto-ingested', project: workspace, ecosystem: '*' },
                        });
                    } catch (embedErr) {
                        log.warn(`[Lore Source Watcher] embedding failed for ${filePath}: ${(embedErr as Error).message}`);
                    }
                }

                // Debounced freshness sweep: ensures local-only workspaces
                // (no cloud sync → pullRemote never fires) still get an
                // up-to-date freshness report after file activity.
                const now = Date.now();
                if (now - _lastSweepMs >= SWEEP_DEBOUNCE_MS) {
                    _lastSweepMs = now;
                    sweepFreshness(graph as unknown as IFreshnessGraph, workspace).catch((e) => {
                        log.warn(`[Lore Source Watcher] freshness sweep failed: ${(e as Error).message}`);
                    });
                }
            } catch (err) {
                log.warn(
                    `[Lore Source Watcher] auto-ingest failed for ${filePath}: ${(err as Error).message}`,
                );
            }
        })();
    };
}

/**
 * startLocalSourceWatcher — Start the CDC-equivalent watcher for local
 * knowledge-source directories. Reads LORE_WATCH_PATHS and watches for
 * file changes to md/txt/rst files. Stashes the instance on globalThis
 * so stopAllLocalWatchers() can reach it on SIGTERM. Non-fatal.
 *
 * @param onChanged - Callback fired with the absolute path of each changed
 *   file. Use makeFileIngestCallback() to build a graph + vector write.
 */
export async function startLocalSourceWatcher(
    onChanged: (filePath: string) => void,
): Promise<void> {
    try {
        const watcher = new LocalSourceWatcher();
        watcher.start(onChanged);
        (globalThis as unknown as { __loreSourceWatcher?: LocalSourceWatcher }).__loreSourceWatcher = watcher;
    } catch (err) {
        log.error(`[Lore MCP] local-source-watcher startup failed (non-fatal): ${(err as Error).message}`);
    }
}

/**
 * stopAllLocalWatchers — Gracefully stop the globalThis-stashed
 * LocalSourceWatcher (__loreSourceWatcher). Called from the SIGTERM /
 * onShutdown handler in server.ts. Errors are swallowed so shutdown never
 * hangs on a watcher that already died.
 */
export function stopAllLocalWatchers(): void {
    const g = globalThis as Record<string, unknown>;
    const src = g.__loreSourceWatcher as LocalSourceWatcher | undefined;
    if (src) void src.stop();
}

/**
 * Phase 6 P1.B/P1.C — boot-construct the multi-workspace LocalGraph
 * registry. Primed with the boot-bound active graph so getOrOpen(active)
 * returns the SAME instance (single-writer Kùzu constraint); sibling
 * workspaces lazy-open on first access. Cloud mode skips wiring.
 */
export function buildGraphRegistryForLocalMode(
    deploymentMode: 'local' | 'cloud',
    graph: LoreGraphHandle,
    activeWorkspace: string,
    home: string = loreHome(),
    opts: { autoEvict?: boolean } = { autoEvict: true },
): LocalGraphRegistry | undefined {
    // Gate on MODE, not on the Kùzu class. `graph instanceof LocalGraph` was
    // equivalent while local mode could only mean Kùzu; once `createGraph`
    // honours the workspace's declared engine, a Surreal-backed boot workspace
    // would have returned `undefined` here — no registry at all, so every
    // per-workspace HTTP route silently fell back to the boot handle and the
    // whole workspace-isolation boundary went with it.
    if (deploymentMode !== 'local' || !isWorkspaceGraph(graph)) return undefined;
    // SP-11 — autoEvict closes idle/over-cap lazily-opened sibling
    // workspaces so a multi-repo daemon doesn't keep every workspace's
    // Kùzu + LanceDB handle open forever. The boot graph is primed +
    // pinned below and is never evicted by the registry.
    // TW-2a — `home` scopes every workspaces.json read inside the registry
    // to this instance's data root; `opts.autoEvict` lets the embedded path
    // construct the registry WITHOUT the idle-sweep timer (the embedded
    // contract forbids host-leaked timers — embedded drives evictIdle from
    // dispose() instead). Daemon callers keep the default autoEvict:true.
    const reg = new LocalGraphRegistry({ autoEvict: opts.autoEvict !== false, home });
    // V1 (Sprint V): the bootstrap graph is opened at
    // `resolveGraphPath()` = `getActiveWorkspacePath()` — the path of
    // whatever workspace is `active` in workspaces.json. Prime under
    // that name so subsequent `getOrOpen(activeName)` returns this
    // same instance instead of constructing a second writer racing
    // against the bootstrap graph on the same Kùzu file.
    //
    // The `activeWorkspace` parameter (from `detectedScope.workspace`)
    // can be `"*"` when the daemon's CWD doesn't match any registered
    // path. `prime("*", graph)` silently no-ops because `"*"` is not a
    // registered workspace — which left the cache empty pre-fix and
    // caused every HTTP POST routed through the registry to open a
    // fresh LocalGraph that the bootstrap graph (used by GET handlers)
    // could not see. Result: store_node says ok:true but get_full
    // returns 404 — the bug V1 was scoped to close.
    const activeName = getActiveWorkspaceName(home);
    reg.prime(activeName, graph);
    // Backward-compat: if `detectedScope.workspace` is a real
    // registered workspace different from active, also prime under
    // that name. `prime()` self-validates the path matches before
    // caching, so a stale `detectedScope` cannot lie to the registry.
    if (activeWorkspace !== '*' && activeWorkspace !== activeName) {
        reg.prime(activeWorkspace, graph);
    }
    return reg;
}

/**
 * SP-F3 — prime the per-workspace verbatim resolver with the boot verbatim
 * store, mirroring buildGraphRegistryForLocalMode's prime of the boot graph.
 * The resolver reuses the daemon's existing LanceDB handle for the active
 * (and detected, if different) workspace instead of opening a second handle
 * on the same dir. No-op when the resolver is absent (cloud mode). The
 * resolver is typed structurally to avoid importing the concrete class here.
 */
export function primeWorkspaceVerbatimResolver(
    resolver: { prime: (workspace: string, store: VerbatimStore) => void } | undefined,
    bootVerbatim: VerbatimStore,
    detectedWorkspace: string,
    home: string = loreHome(),
): void {
    if (!resolver) return;
    const activeName = getActiveWorkspaceName(home);
    resolver.prime(activeName, bootVerbatim);
    if (detectedWorkspace !== '*' && detectedWorkspace !== activeName) {
        resolver.prime(detectedWorkspace, bootVerbatim);
    }
}

/**
 * Wave 4.3 — boot-construct the per-workspace SyncEngine registry, mirroring
 * buildGraphRegistryForLocalMode's prime-then-lazy-open shape. Primed with
 * the boot-bound SyncEngine so getOrOpen(activeName) returns the SAME
 * instance instead of constructing a second WriteAheadLog over the boot
 * workspace's `.lore/` dir (only the boot engine auto-syncs). Returns
 * undefined when graphRegistry or the verbatim resolver aren't wired
 * (cloud mode) — routes/sync.ts falls back to the single boot engine then.
 */
export function buildSyncEngineRegistryForLocalMode(opts: {
    graphRegistry: LocalGraphRegistry | undefined;
    workspaceVerbatimResolver: WorkspaceVerbatimResolver | undefined;
    getAdapter: () => TsSdkAdapter | null;
    outboxStore: OutboxStore;
    deploymentMode: 'local' | 'cloud' | 'embedded';
    bootSyncEngine: SyncEngine;
    activeWorkspace: string;
    home?: string;
}): SyncEngineRegistry | undefined {
    if (!opts.graphRegistry || !opts.workspaceVerbatimResolver) return undefined;
    const reg = new SyncEngineRegistry({
        graphRegistry: opts.graphRegistry,
        workspaceVerbatimResolver: opts.workspaceVerbatimResolver,
        getAdapter: opts.getAdapter,
        outboxStore: opts.outboxStore,
        deploymentMode: opts.deploymentMode,
        home: opts.home,
    });
    const activeName = opts.graphRegistry.activeName();
    reg.prime(activeName, opts.bootSyncEngine);
    if (opts.activeWorkspace !== '*' && opts.activeWorkspace !== activeName) {
        reg.prime(opts.activeWorkspace, opts.bootSyncEngine);
    }
    return reg;
}

/**
 * resolveToolTier — global tool-tier hint (v1.1 deferred item #7).
 *
 * Tool registration reads this to expose a reduced tool surface in 'slim'
 * mode. `LORE_TOOL_TIER` sets a single global default; unrecognised values
 * fall back to 'default'. Pure env read — extracted from server.ts (boot-
 * wiring file-size budget, SW-31).
 */
export function resolveToolTier(): 'default' | 'slim' | 'opt-in' {
    const raw = (process.env['LORE_TOOL_TIER'] ?? '').trim().toLowerCase();
    return raw === 'slim' || raw === 'opt-in' || raw === 'default'
        ? (raw as 'default' | 'slim' | 'opt-in')
        : 'default';
}

/**
 * The raw-Cypher escape hatch the schema subsystem's Kùzu path runs on.
 * Kùzu's `LocalGraph` exposes it; `SurrealGraph` and `DataplaneGraph` do not.
 */
export interface GraphCypherContext {
    queryRows(cypher: string, params?: Record<string, unknown>): unknown;
    executeQuery(cypher: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * A graph handle that may expose EITHER the engine-agnostic schema-ops port
 * directly (`SurrealGraph.getSchemaGraphOps()`) or the raw-Cypher hatch
 * (`LocalGraph.getGraphContext()`, wrapped into `KuzuSchemaGraphOps` below).
 *
 * Optional because the boot graph's actual shape depends on the workspace's
 * declared engine (`createGraph` resolves it): a `SurrealGraph` has the
 * former, a Kùzu `LocalGraph` has the latter, and a `DataplaneGraph` (cloud
 * mode) has neither — this subsystem doesn't run there.
 *
 * Intersected with `LoreGraphHandle` rather than declared standalone so it
 * is not a weak type — every real graph satisfies the handle, and only the
 * two hatches are in question.
 */
export type SchemaOpsCapableGraph = LoreGraphHandle & {
    getSchemaGraphOps?(): SchemaGraphOps;
    getGraphContext?(): GraphCypherContext;
};

/**
 * buildGraphReaders — the `SchemaGraphOps` adapter that bridges
 * SchemaAuthoringStore + the migration backend onto the live graph's
 * engine-agnostic schema-ops port (`schemas/substrate/schemaGraphOps.ts`).
 * Formerly a Kùzu-only raw-Cypher adapter gated by `assertKuzuGraphSubstrate`;
 * now selects the ops instance for whichever engine the workspace actually
 * runs, so blast radius / the pre-destructive snapshot / migration execution
 * work on a SurrealDB-backed workspace instead of being refused.
 *
 * Takes `getGraph` (not the graph itself) so the boot-mutable `graph`
 * binding — which main()'s keychain-upgrade may reassign — is read fresh on
 * every call. Every method on the returned `SchemaGraphOps` re-resolves the
 * concrete implementation before delegating, so a mid-boot reassignment is
 * observed the same way the old queryRows-closure design was. Extracted to
 * keep server.ts under the file-size budget (SW-31).
 */
export function buildGraphReaders(
    getGraph: () => SchemaOpsCapableGraph,
    /**
     * Phase 3 — which workspace these readers are bound to. Used only for
     * the refusal message when the handle exposes neither hatch (see
     * `resolve` below) — every local-mode engine has one, so that path is
     * an invariant violation, not a normal capability gap.
     */
    workspaceOf: () => string,
    /**
     * Lore data root the workspace selector reads from. Defaults to the
     * process-global `LORE_HOME`, which is right for the daemon. Injectable
     * for the same reason `LocalGraphRegistry` takes a `home`: an embedded
     * instance (or a test) must be able to resolve a disjoint set of
     * workspaces instead of colliding on the global.
     */
    homeOf?: () => string | undefined,
): { schemaGraphOps: SchemaGraphOps } {
    const resolve = (operation: string): SchemaGraphOps => {
        const g = getGraph();
        if (typeof g.getSchemaGraphOps === 'function') {
            return g.getSchemaGraphOps();
        }
        if (typeof g.getGraphContext === 'function') {
            const ctx = g.getGraphContext();
            return new KuzuSchemaGraphOps({
                queryRows: async (cypher, params) =>
                    await ctx.queryRows(cypher, params) as Array<Record<string, unknown>>,
                executeWrite: async (cypher, params) => { await ctx.executeQuery(cypher, params); },
            });
        }
        // Neither hatch present. Every local-mode engine (Kùzu, SurrealDB)
        // has one, so this is either an invariant violation (whoever
        // supplied the graph handle) or this seam reached from a deployment
        // mode (cloud) it was never meant to serve — named refusal rather
        // than a raw TypeError three frames down.
        throw new GraphSubstrateUnsupportedError(
            operation,
            resolveWorkspaceGraphEngine(workspaceOf(), homeOf?.()),
            'the schema subsystem needs getSchemaGraphOps() or getGraphContext() on the graph handle',
        );
    };
    const schemaGraphOps: SchemaGraphOps = {
        get engine() { return resolve('schema_graph_engine').engine; },
        countNodesByType: (type) => resolve('countNodesByType').countNodesByType(type),
        countEdgesByRelation: (relation) => resolve('countEdgesByRelation').countEdgesByRelation(relation),
        countInboundEdgesToType: (type) => resolve('countInboundEdgesToType').countInboundEdgesToType(type),
        listNodesByType: (type) => resolve('listNodesByType').listNodesByType(type),
        listEdgesByRelation: (relation) => resolve('listEdgesByRelation').listEdgesByRelation(relation),
        pageNodesByType: (type, afterId, limit) => resolve('pageNodesByType').pageNodesByType(type, afterId, limit),
        sampleNodesByType: (type, sampleN) => resolve('sampleNodesByType').sampleNodesByType(type, sampleN),
        sampleEdgesByRelation: (relation, sampleN) =>
            resolve('sampleEdgesByRelation').sampleEdgesByRelation(relation, sampleN),
        deleteNodesByType: (type, limit) => resolve('deleteNodesByType').deleteNodesByType(type, limit),
        deleteEdgesByRelation: (relation, limit) =>
            resolve('deleteEdgesByRelation').deleteEdgesByRelation(relation, limit),
        getNodeMetadata: (id) => resolve('getNodeMetadata').getNodeMetadata(id),
        setNodeMetadata: (id, metadata) => resolve('setNodeMetadata').setNodeMetadata(id, metadata),
        setNodeType: (id, newType) => resolve('setNodeType').setNodeType(id, newType),
        restoreNode: (row) => resolve('restoreNode').restoreNode(row),
        createEdge: (sourceId, targetId, relation) =>
            resolve('createEdge').createEdge(sourceId, targetId, relation),
    };
    return { schemaGraphOps };
}
