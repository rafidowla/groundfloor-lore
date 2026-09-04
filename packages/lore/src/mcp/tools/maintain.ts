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
import { getWorkspacePath, getActiveWorkspaceName } from '../../config/workspaces.js';
import { resolveTargetGraph } from './workspaceResolve.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
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
    deploymentMode: 'local' | 'cloud';
    /**
     * Per-workspace graph registry (local-mode, Postgres model). When wired,
     * a non-active workspace target resolves ITS OWN graph for node retention
     * instead of falling back to the boot graph. Optional: when absent, node
     * retention runs only for the active workspace (legacy behavior), keeping
     * this file independently tsc-safe.
     */
    graphRegistry?: LocalGraphRegistry;
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
            disable: z.array(z.enum(['compaction', 'versionCleanup', 'nodeRetention', 'ephemeralExpiry'])).optional()
                .describe('Operations to skip this run.'),
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
                if (args.disable && args.disable.length > 0) {
                    overrides.enabled = {};
                    for (const op of args.disable) overrides.enabled[op] = false;
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
                const wsName = args.workspace ?? getCurrentPrincipal()?.workspace ?? getActiveWorkspaceName();
                const wsPath = getWorkspacePath(wsName);

                // Per-workspace ops: LanceDB + node retention. LanceDB always
                // routes by path to the requested workspace's lancedb dir. Node
                // retention must route to the REQUESTED workspace's graph, not the
                // boot/active store (Postgres-model isolation). When a graphRegistry
                // is wired, resolve that workspace's own LocalGraph via
                // resolveTargetGraph; when it is absent (cloud-mode / tests), fall
                // back to the boot graph only for the active workspace, preserving
                // the prior behavior.
                const activeName = getActiveWorkspaceName();
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
                const storePolicy = {
                    ...policy,
                    enabled: { compaction: false, versionCleanup: false, nodeRetention: false, ephemeralExpiry: mayStoreWide && policy.enabled.ephemeralExpiry },
                };
                const storeReport = await runMaintenance(storePolicy, {
                    // re-audit 2026-06-25 — pass the live registry so an ephemeral
                    // workspace's open graph handle is closed before its dir is deleted.
                    workspaces: new WorkspaceRegistry(deps.graphRegistry),
                    safety: new AlwaysSafe(),
                }, { dryRun, scopeLabel: 'store:ephemeral-workspaces' });

                return { content: [{ type: 'text', text: JSON.stringify({ ok: true, dryRun, reports: [wsReport, storeReport] }) }] };
            } catch (err) {
                return { content: [{ type: 'text', text: `maintain failed: ${redactError(err)}` }], isError: true };
            }
        },
    );
}
