/**
 * maintain.ts — `maintain` MCP tool (Lore Core capacity management).
 *
 * Exposes the config-driven maintenance capability to agents/apps so any
 * Lore consumer can keep its store healthy without shelling out to the
 * CLI. Unlike `lore maintain` (CLI), this tool
 * runs INSIDE the daemon — it IS the writer — so it is online-safe by
 * construction and never refuses on a live daemon.
 *
 * Safety default: dry_run defaults to TRUE. An agent must explicitly pass
 * dry_run=false to perform destructive work.
 *
 * Operations are config-driven (defaults → LORE_MAINTAIN_* env → tool
 * args). See engines/maintain for the policy model.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StorageBundle } from '../services.js';
import { redactError } from '../../security/logRedact.js';
import { assertMcpScope } from './mcpScope.js';
import { getCurrentPrincipal } from '../../auth/principal.js';
import * as path from 'node:path';
import { getWorkspacePath, loadWorkspacesIfPresent } from '../../config/workspaces.js';
import { resolveTargetGraph } from './workspaceResolve.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import type { LoreDeploymentMode } from '../server.js';
import { runVersionPruneSweep, resolveRetentionDays } from '../versionPruneScheduler.js';
import type { VersionStore } from '../../outbox/versionStore.js';
import {
    resolveMaintainPolicy,
    runMaintenance,
    LanceMaintainer,
    GraphNodeStore,
    WorkspaceRegistry,
    AlwaysSafe,
    parseDuration,
    parseList,
    type MaintainPolicyOverrides,
    type GraphLike,
} from '../../engines/maintain/index.js';

export interface MaintainToolsDeps {
    store: StorageBundle;
    /** Active workspace base path (where `.lore/lancedb` + graph live). */
    graphBasePath: string;
    /**
     * Defect 3 (3.20.2) — this instance's own data root (`LoreInstance.dataHome`).
     * Every workspace-registry lookup this tool makes (active-name, named-workspace
     * path resolution, ephemeral-expiry sweep) now resolves against THIS home
     * instead of the process-wide `loreHome()` default, so an embedded host with
     * its own `dataDir` never reads or bootstraps a registry that belongs to
     * whatever `LORE_HOME`/`~/.groundfloor` happens to be in the current process
     * env. Required (not optional) so every call site is forced to pass it
     * explicitly — see server.ts/createMcpServer.ts for the one place it's threaded.
     */
    dataHome: string;
    deploymentMode: 'local' | 'cloud';
    /**
     * Defect 3 (3.20.2) — the instance's full run mode, distinct from the
     * collapsed `deploymentMode` above ('embedded' also reports as 'local'
     * there). Optional so existing test fixtures that don't wire it keep
     * compiling; absence is treated as non-embedded (today's behavior).
     * Used only to default ephemeral-workspace expiry OFF in embedded mode
     * (fix requirement #2) unless the caller explicitly asks for it.
     */
    runMode?: LoreDeploymentMode;
    /**
     * Per-workspace graph registry (local-mode, Postgres model). When wired,
     * a non-active workspace target resolves ITS OWN graph for node retention
     * instead of falling back to the boot graph. Optional: when absent, node
     * retention runs only for the active workspace (legacy behavior), keeping
     * this file independently tsc-safe.
     */
    graphRegistry?: LocalGraphRegistry;
    /**
     * Fix Requirement 4 (Defect 3, 3.20.2 review) — this instance's own
     * versions.sqlite store (Feature 8), when wired. The daemon-only
     * `versionPruneSweeper` (daemonTimers.ts) is gated on `startsDaemonTimers`,
     * which is false for embedded — so an embedded host had NO path to bound
     * `versions.sqlite` growth (896MB observed in the wild — see
     * versionPruneScheduler.ts) until this. `maintain` now runs the SAME
     * entry point the daemon scheduler uses (`runVersionPruneSweep`) when this
     * is present. Optional: absent in cloud mode, in test fixtures that don't
     * wire one, or when the boot-time VersionStore.open() failed (server.ts
     * logs and continues without it) — the op is then omitted from the report
     * entirely rather than thrown. Boot-scoped like the daemon sweeper (one
     * store per instance, not fanned out per requested workspace — see
     * versionPruneScheduler.ts's own "Scope" section).
     */
    versionStore?: VersionStore;
}

/**
 * Defect 3 (3.20.2) — resolve the active workspace's {name, path} for `home`
 * WITHOUT ever bootstrapping a `workspaces.json` there. `getActiveWorkspaceName`
 * (via `loadWorkspaces`) writes a first-run registry when none exists, which is
 * exactly the side effect that used to plant a stray `workspaces.json` in an
 * embedded instance's `dataHome` (or the process-wide home) on a mere maintain
 * probe. `loadWorkspacesIfPresent` returns `null` instead of migrating; falling
 * back to `{name: 'default', path: fallbackPath}` matches what the
 * (never-run) migration would have named the sole workspace anyway, so
 * callers see the same label either way.
 *
 * Post-review fix (3.20.2) — this used to return only the name, and callers
 * paired that LIVE name with a boot-time path (`deps.graphBasePath`). If the
 * active workspace changed after boot without a restart (POST
 * /api/workspaces/switch before its drain completes, or `lore workspaces
 * switch`, which only prints "Restart the Lore service"), the name and path
 * disagreed: a `maintain` call would label its report with the NEW active
 * workspace's name while actually compacting/pruning the OLD (boot-time)
 * workspace's LanceDB — irreversible version cleanup against the wrong
 * store, silently. Returning both from the SAME registry read keeps them in
 * lockstep: whichever workspace the registry says is active right now is the
 * one whose name AND path get used.
 */
function safeActiveWorkspace(home: string, fallbackPath: string): { name: string; path: string } {
    try {
        const file = loadWorkspacesIfPresent(home);
        if (!file) return { name: 'default', path: fallbackPath };
        const entry = file.workspaces.find((w) => w.name === file.active);
        // An `active` pointer with no matching entry is a corrupt registry;
        // fall back to the boot path rather than resolving to `undefined`.
        return entry ? { name: entry.name, path: entry.path } : { name: file.active, path: fallbackPath };
    } catch {
        return { name: 'default', path: fallbackPath };
    }
}

export function registerMaintainTools(mcpServer: McpServer, deps: MaintainToolsDeps): void {
    mcpServer.tool(
        'maintain',
        'Run config-driven capacity maintenance against the Lore store: LanceDB compaction + version cleanup, cold-node retention, and ephemeral-workspace expiry. Online-safe (runs inside the daemon). Defaults to dry_run=true — pass dry_run=false to apply.',
        {
            dry_run: z.boolean().optional().describe('Report only (default true). Pass false to perform writes.'),
            workspace: z.string().optional().describe('Workspace to maintain (default: active). LanceDB + node retention are per-workspace.'),
            retention_days: z.number().int().optional().describe('Cold-node age threshold in days (default 90).'),
            cleanup_versions_older_than: z.string().optional().describe('LanceDB version cutoff, e.g. "7d" or "168h" (default 7d).'),
            compact_fragment_threshold: z.number().int().optional().describe('Min fragments before compacting a table (default 200).'),
            ephemeral_workspace_ttl_days: z.number().int().optional().describe('Ephemeral workspace TTL in days (default 14).'),
            ephemeral_workspace_patterns: z.string().optional().describe('CSV of ephemeral patterns (default "e2e-*,*-smoke,*-test").'),
            protect_tags: z.string().optional().describe('CSV of tags that are never touched (default "pinned,protected").'),
            node_action: z.enum(['archive', 'delete']).optional().describe('Retention action (default archive).'),
            cold_signal: z.enum(['retrieval', 'access', 'update']).optional()
                .describe('Recency clock for "cold": retrieval=last intentional recall/search (default), access=any read incl. graph-view, update=updatedAt proxy.'),
            disable: z.array(z.enum(['compaction', 'versionCleanup', 'nodeRetention', 'ephemeralExpiry', 'versionsSqlitePrune'])).optional()
                .describe('Operations to skip this run.'),
            versions_sqlite_retention_days: z.number().int().optional()
                .describe('versions.sqlite row-age threshold in days before soft-compact/hard-delete (default: LORE_VERSION_RETENTION_DAYS env, else 90). Independent of `retention_days` (cold-node retention) and `cleanup_versions_older_than` (LanceDB).'),
        },
        async (args) => {
            try {
                if (deps.deploymentMode === 'cloud') {
                    return { content: [{ type: 'text', text: JSON.stringify({ error: 'maintain_local_only', hint: 'maintain operates on local-disk substrates (LanceDB/SurrealDB); not applicable in cloud mode.' }) }], isError: true };
                }
                // SP-01 — destructive maintenance against a workspace's
                // substrates. Enforce bound-principal write scope. When
                // `workspace` is omitted it defaults to the principal's own
                // binding (always allowed); a scoped principal naming
                // another workspace is refused.
                const scopeDenied = assertMcpScope(args.workspace as string | undefined, 'write');
                if (scopeDenied) return scopeDenied;
                const overrides: MaintainPolicyOverrides = {};
                if (args.retention_days !== undefined) overrides.retentionDays = args.retention_days;
                if (args.cleanup_versions_older_than) overrides.cleanupVersionsOlderThanMs = parseDuration(args.cleanup_versions_older_than);
                if (args.compact_fragment_threshold !== undefined) overrides.compactFragmentThreshold = args.compact_fragment_threshold;
                if (args.ephemeral_workspace_ttl_days !== undefined) overrides.ephemeralWorkspaceTtlDays = args.ephemeral_workspace_ttl_days;
                if (args.ephemeral_workspace_patterns) overrides.ephemeralWorkspacePatterns = parseList(args.ephemeral_workspace_patterns);
                if (args.protect_tags) overrides.protectTags = parseList(args.protect_tags);
                if (args.node_action) overrides.nodeRetentionAction = args.node_action;
                if (args.cold_signal) overrides.coldSignal = args.cold_signal;
                // `versionsSqlitePrune` (Fix Requirement 4) is not one of the
                // engine's own `MaintainOperation`s — it targets versions.sqlite
                // via VersionStore/runVersionPruneSweep below, not `runMaintenance`
                // — so it is pulled out here and handled separately rather than
                // fed into `overrides.enabled`, which is typed to the engine's
                // 4 existing ops only.
                const versionsSqlitePruneDisabled = args.disable?.includes('versionsSqlitePrune') ?? false;
                const enginePolicyDisables = args.disable?.filter(
                    (op): op is 'compaction' | 'versionCleanup' | 'nodeRetention' | 'ephemeralExpiry' => op !== 'versionsSqlitePrune',
                ) ?? [];
                if (enginePolicyDisables.length > 0) {
                    overrides.enabled = {};
                    for (const op of enginePolicyDisables) overrides.enabled[op] = false;
                }

                const policy = resolveMaintainPolicy(overrides);
                const dryRun = args.dry_run ?? true;
                // R3-001 — when `workspace` is omitted, bind to the PRINCIPAL's
                // own workspace, NOT the daemon-active one. The scope gate above
                // (assertMcpScope(args.workspace, 'write')) checks the principal's
                // own ws for the undefined case, so defaulting to active here let
                // a scoped token run destructive retention/compaction against
                // whatever ws was active (another app's). Null principal = local
                // bypass → active (matches the comment at the gate).
                //
                // Defect 3 (3.20.2) — every lookup below resolves against
                // `deps.dataHome` (this instance's own data root), never the
                // process-wide `loreHome()` default `getWorkspacePath`/
                // `getActiveWorkspaceName` used to fall back to. `explicitWs`
                // deliberately covers BOTH an explicit `workspace` arg AND a
                // scoped principal's own binding, matching the PRE-FIX behavior
                // where `wsPath` was always `getWorkspacePath(wsName)` regardless
                // of which of the three sources `wsName` came from — a principal
                // bound to a non-active workspace must still resolve its OWN path
                // via the registry, not silently fall through to the boot graph.
                // Only when NEITHER is set — the common embedded case, no
                // multi-tenant registry involved at all — do we skip the registry
                // entirely and use `deps.graphBasePath` directly, which is what
                // stops a plain maintain probe from ever reading (and, via the
                // first-run migration, bootstrapping) a workspaces.json it has no
                // need for.
                const explicitWs = args.workspace ?? getCurrentPrincipal()?.workspace;
                // Finding 1 (post-review, 3.20.2) — `wsName` and `wsPath` used to
                // come from two independent registry reads (a live one for the
                // name, `deps.graphBasePath` — a BOOT-TIME value — for the path).
                // If the active workspace changed after boot without a restart,
                // the report would carry the NEW active name while a non-dry-run
                // call actually mutated the OLD (boot-time) workspace's LanceDB.
                // `safeActiveWorkspace` reads the registry ONCE and returns both
                // together so they can never disagree.
                const active = safeActiveWorkspace(deps.dataHome, deps.graphBasePath);
                const wsName = explicitWs ?? active.name;
                const wsPath = explicitWs ? getWorkspacePath(explicitWs, deps.dataHome) : active.path;

                // Per-workspace ops: LanceDB + node retention. LanceDB always
                // routes by path to the requested workspace's lancedb dir. Node
                // retention must route to the REQUESTED workspace's graph, not the
                // boot/active store (Postgres-model isolation). When a graphRegistry
                // is wired, resolve that workspace's own LocalGraph via
                // resolveTargetGraph; when it is absent (cloud-mode / tests), fall
                // back to the boot graph only for the active workspace, preserving
                // the prior behavior.
                const activeName = active.name;
                let nodeStore: GraphNodeStore | undefined;
                if (deps.graphRegistry) {
                    const resolved = await resolveTargetGraph(deps.store, deps.graphRegistry, activeName, wsName);
                    if (resolved.ok) {
                        nodeStore = new GraphNodeStore(resolved.graph as unknown as GraphLike);
                    }
                    // If the requested workspace is unknown/missing, leave node
                    // retention off for this run rather than silently retaining the
                    // wrong (active) workspace's nodes; LanceDB path-routing and the
                    // store-wide sweep below are unaffected.
                } else if (wsName === activeName) {
                    nodeStore = new GraphNodeStore(deps.store.loreGraph as unknown as GraphLike);
                }
                const perWsPolicy = { ...policy, enabled: { ...policy.enabled, ephemeralExpiry: false } };
                const wsReport = await runMaintenance(perWsPolicy, {
                    lance: new LanceMaintainer(path.join(wsPath, '.lore', 'lancedb')),
                    nodes: nodeStore,
                    safety: new AlwaysSafe(),
                }, { dryRun, scopeLabel: `workspace:${wsName}` });

                // Store-level ephemeral workspace expiry (once).
                // F-T08/S09 (re-audit 2026-06-27) — this branch deletes NON-ACTIVE
                // workspaces store-wide using caller-controlled patterns + TTL
                // (ttl=0 + pattern '*' → fs.rmSync of every other workspace). The
                // per-workspace `assertMcpScope(workspace, 'write')` above does NOT
                // authorize a store-wide sweep, and the prior gate
                // (`kind !== 'app' || cross-workspace-write`) let the cloud
                // shared-secret AND any caller-supplied destructive pattern through.
                // Tighten to the operator-only bar used by destructive schema
                // migrations (mcp/http/routes/schema/migrations.ts denyNonHumanOperator):
                //   - null principal  → local/legacy/test bypass (preserved).
                //   - kind==='bootstrap' → the local human operator. Allowed.
                //   - kind==='app' | 'shared-secret' → a service/automation
                //     principal cannot self-attest the operator identity required
                //     for a store-wide destructive sweep. Rejected (sweep disabled).
                // A non-operator principal also must NOT drive the sweep with its
                // own caller-supplied ephemeral patterns/TTL; disabling the op for
                // non-operators removes that trust path entirely.
                const principal = getCurrentPrincipal();
                const mayStoreWide = !principal || principal.kind === 'bootstrap';
                // Fix requirement #2 (Defect 3, 3.20.2) — in embedded mode,
                // ephemeral expiry must never touch a registry other than the
                // instance's own. An embedded host is typically single-tenant
                // with no multi-workspace registry at all, so default this op
                // OFF there. Daemon/local/cloud behavior (runMode undefined or
                // !== 'embedded') is completely unchanged. `WorkspaceRegistry`
                // below is ALSO now scoped to `deps.dataHome` regardless of
                // this gate, so even an explicit `disable` stays confined to
                // the instance's own home.
                //
                // Finding 4 (MINOR, post-review) — `ephemeralExplicitlySet` is
                // NOT an opt-in escape hatch, despite what an earlier version
                // of this comment implied. `overrides.enabled` is populated
                // only from `args.disable` (see above), which only ever
                // assigns `false` — no request field can set
                // `enabled.ephemeralExpiry` to `true`. So this flag can only
                // ever be true when the caller redundantly disabled an op
                // embedded mode had already defaulted off; it can never be
                // used to turn the op ON in embedded mode.
                const ephemeralExplicitlySet = overrides.enabled?.ephemeralExpiry !== undefined;
                const embeddedDefaultOff = deps.runMode === 'embedded' && !ephemeralExplicitlySet;
                const storePolicy = {
                    ...policy,
                    enabled: { compaction: false, versionCleanup: false, nodeRetention: false, ephemeralExpiry: mayStoreWide && policy.enabled.ephemeralExpiry && !embeddedDefaultOff },
                };
                const storeReport = await runMaintenance(storePolicy, {
                    // re-audit 2026-06-25 — pass the live registry so an ephemeral
                    // workspace's open graph handle is closed before its dir is deleted.
                    // Defect 3 (3.20.2) — scoped to deps.dataHome, not the
                    // process-wide loreHome() default.
                    workspaces: new WorkspaceRegistry(deps.graphRegistry, deps.dataHome),
                    safety: new AlwaysSafe(),
                }, { dryRun, scopeLabel: 'store:ephemeral-workspaces' });

                // Fix Requirement 4 (Defect 3, 3.20.2 review, Finding 2) —
                // versions.sqlite pruning. The daemon-only `versionPruneSweeper`
                // (daemonTimers.ts) never runs in embedded mode (gated on
                // `startsDaemonTimers`), so an embedded host had NO path to
                // bound versions.sqlite growth (896MB observed — see
                // versionPruneScheduler.ts) other than restarting into daemon
                // mode. This reuses the SAME sweep the daemon scheduler calls,
                // boot-scoped to `deps.versionStore` (one store per instance,
                // matching that scheduler's own documented scope — see its
                // "Scope" section for why a full per-workspace fan-out is a
                // separate, larger change).
                //
                // dry_run=true (default) never mutates: `pruneVersions`/
                // `hardDeleteCompacted` are writes, so the preview uses the
                // read-only `countPrunable` instead. Disabled via
                // `disable: ['versionsSqlitePrune']` skips this block entirely
                // (report omits `versionsSqlite`) — matching how the other ops
                // report nothing when disabled at the engine-policy level.
                let versionsSqlite: unknown;
                if (deps.versionStore && !versionsSqlitePruneDisabled) {
                    const retentionDays = args.versions_sqlite_retention_days;
                    if (dryRun) {
                        const preview = deps.versionStore.countPrunable(retentionDays ?? resolveRetentionDays());
                        versionsSqlite = { dryRun: true, ...preview };
                    } else {
                        const result = await runVersionPruneSweep({ store: deps.versionStore, retentionDays });
                        versionsSqlite = { dryRun: false, ...result };
                    }
                }

                return { content: [{ type: 'text', text: JSON.stringify({ ok: true, dryRun, reports: [wsReport, storeReport], versionsSqlite }) }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `maintain failed: ${redactError(err)}` }], isError: true };
            }
        },
    );
}
