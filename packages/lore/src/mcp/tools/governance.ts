/**
 * governance.ts — Operational/admin tools that don't fit elsewhere.
 *
 * Tools:
 *   - register_workspace  add/update a row in workspace-paths.json
 *   - list_workspaces     read workspaces.json — active + all registered
 *   - sync_status         WAL + adapter snapshot
 *   - sync_now            manual Dataplane round-trip (push/pull/both)
 *   - resolve_deferred    stamp metadata.resolved_at on a deferred-* node
 *   - get_hot_context     LocalGraph.sessionCache top-N
 *   - prune_ephemeral     drop expired ephemeral scratchpad nodes
 *
 * Tools whose deps are all module-scope service singletons. Bundled
 * here because each is small (10-100 lines) and they share the
 * boilerplate try/catch + JSON.stringify response shape.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SyncEngine } from '../../engines/syncEngine.js';
import {
    readWorkspaceRegistry,
    writeWorkspaceRegistry,
    upsertWorkspaceMapping,
} from '../../config/workspaceRegistry.js';
import { loadWorkspaces } from '../../config/workspaces.js';
import { resolveWorkspaceGraphEngine } from '../../engines/graphEngineSelector.js';
import { assertMcpScope } from './mcpScope.js';
import type { StorageBundle } from '../services.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import type { ISessionCache } from '../../engines/sessionCache.js';
import {
    resolveTargetGraph,
    workspaceRequiredEnvelope,
} from './workspaceResolve.js';
import { mcpToolError } from './mcpToolError.js';
import { log } from '../../logger.js';
import { safePruneEphemeralNodes } from '../../engines/safeEphemeralPrune.js';
import type { OutboxStore } from '../../outbox/types.js';

export interface GovernanceToolsDeps {
    store: StorageBundle;
    /** SyncEngine is `let`-mutable in main(); read fresh per call. */
    getSyncEngine: () => SyncEngine;
    /**
     * Phase 6 / local-mode (Postgres model) — multi-workspace LocalGraph
     * registry. When wired, the workspace-taking graph tools in this file
     * (resolve_deferred, get_hot_context, prune_ephemeral) resolve the
     * target graph via `resolveTargetGraph(...)` so the op physically reads/
     * writes the REQUESTED workspace's store instead of the boot/active one.
     * Optional so cloud-mode + test fixtures fall back to `store.loreGraph`
     * (resolveTargetGraph returns the boot store when the registry is absent).
     */
    graphRegistry?: LocalGraphRegistry;
    /**
     * Active (boot-bound) workspace scope, used as the resolver's
     * `activeWorkspace` argument. Optional so fixtures that don't wire it
     * fall back to an empty string (only consulted for the `isActive` flag —
     * routing is driven by the per-call `workspace` argument).
     */
    detectedScope?: { workspace: string; ecosystem: string };
    /**
     * ITEM X-pruneeph (2026-09-03) — `prune_ephemeral`'s per-node delete now
     * goes through the same outbox-first discipline as `delete_node` /
     * `prune_nodes` hard_delete: a `node.delete` row before the substrate
     * delete and a `verbatim.tombstone` row after the vector tombstone.
     * Optional so cloud mode / test fixtures without an outbox wired keep
     * the prior direct-delete-only behavior.
     */
    outboxStore?: OutboxStore;
    /** Per-workspace verbatim resolver — routes the ephemeral-node's
     *  tombstone to the REQUESTED workspace's LanceDB, mirroring
     *  prune_nodes/delete_node. Absent (cloud/tests) → deps.store.loreVerbatim. */
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<StorageBundle['loreVerbatim']> };
}

/** Shared `workspace_not_found` MCP envelope for the resolver's
 *  `{ ok:false, requested, known }` branch. */
function workspaceNotFoundEnvelope(requested: string, known: string[]) {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'workspace_not_found', requested, known }, null, 2),
        }],
        isError: true as const,
    };
}

/** Body for `register_workspace`. Reads the registry, upserts the
 *  mapping, writes back atomically, returns the standard MCP-tool
 *  response. */
async function upsertHelper(input: {
    name: string;
    ecosystem: string;
    pathFragments: string[];
    invokedAs: string;
}) {
    try {
        const registry = readWorkspaceRegistry();
        const { alreadyExisted } = upsertWorkspaceMapping(registry, input.name, {
            ecosystem: input.ecosystem,
            paths: input.pathFragments,
        });
        writeWorkspaceRegistry(registry);
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    success: true,
                    action: alreadyExisted ? 'updated' : 'registered',
                    workspace: { name: input.name, ecosystem: input.ecosystem, paths: input.pathFragments },
                    invokedAs: input.invokedAs,
                    message: `Workspace '${input.name}' ${alreadyExisted ? 'updated' : 'registered'} in ecosystem '${input.ecosystem}'.`,
                }, null, 2),
            }],
        };
    } catch (error) {
        return mcpToolError('register_workspace', error, log);
    }
}

export function registerGovernanceTools(mcpServer: McpServer, deps: GovernanceToolsDeps): void {
    /* ─── register_workspace (canonical) ──────────────────────── */
    mcpServer.tool(
        'register_workspace',
        'Register or update a workspace in the Lore workspace registry. ' +
        'Used by tools that auto-detect scope from CWD.',
        {
            name: z.string().describe('Workspace name (e.g., "videosnap", "tenant-coi")'),
            ecosystem: z.string().describe('Ecosystem group (e.g., "groundfloor")'),
            paths: z.array(z.string()).describe('CWD path fragments that map to this workspace'),
        },
        async ({ name, ecosystem, paths: pathFragments }) => {
            // SP-01 (final-audit 2026-06-18) — register_workspace mutates the
            // workspace registry (workspace-paths.json); its sibling write tools
            // (set_sync_policy, resolve_conflict, set_consent_ttl) all gate, but
            // this one did not. Require write scope for the target workspace.
            const scopeDenied = assertMcpScope(name, 'write');
            if (scopeDenied) return scopeDenied;
            return upsertHelper({
                name,
                ecosystem,
                pathFragments,
                invokedAs: 'register_workspace',
            });
        },
    );

    /* ─── list_workspaces ─────────────────────────────────────── */
    // V2 (Sprint V) — symmetric MCP counterpart to GET /api/workspaces.
    // Reads workspaces.json directly so callers can introspect the
    // active workspace + the full registered set without polling REST.
    mcpServer.tool(
        'list_workspaces',
        'List every registered workspace + the currently-active one. Reads workspaces.json. Returns {active, workspaces:[{name, path, label?, createdAt}]}. Symmetric with GET /api/workspaces.',
        {},
        async () => {
            try {
                const file = loadWorkspaces();
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            active: file.active,
                            workspaces: file.workspaces.map((w) => ({
                                name: w.name,
                                path: w.path,
                                label: w.label ?? null,
                                createdAt: w.createdAt,
                            })),
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('register_workspace', error, log);
            }
        },
    );

    /* ─── sync_status ─────────────────────────────────────────── */
    mcpServer.tool(
        'sync_status',
        'Get the current sync engine status — WAL pending count, last sync time, remote connectivity',
        {
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async ({ workspace }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                // Postgres-model isolation (2026-06-19): there is ONE boot-bound
                // SyncEngine (the active workspace's). It can't report another
                // workspace's sync state, so refuse a non-active target rather than
                // silently returning the active workspace's status under a different
                // name. Per-workspace sync is future work (see DEPLOYMENT_MODEL.md).
                {
                    const active = deps.detectedScope?.workspace;
                    if (active && workspace !== active) {
                        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_active', requested: workspace, active, hint: 'sync operates on the active workspace only; switch the active workspace to sync another.' }, null, 2) }], isError: true };
                    }
                }
                const status = deps.getSyncEngine().getStatus();
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            walPending: status.walPending,
                            lastSync: status.lastSync === '1970-01-01T00:00:00.000Z' ? 'never' : status.lastSync,
                            remoteConfigured: status.hasAdapter,
                            autoSyncing: status.isAutoSyncing,
                            // Was hardcoded to the removed legacy graph engine's name
                            // regardless of what actually backs the workspace — read
                            // the real declared engine instead (defaults to 'surreal'
                            // for an absent/unreadable declaration, same as the daemon).
                            engine: resolveWorkspaceGraphEngine(workspace),
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('register_workspace', error, log);
            }
        },
    );

    /* ─── sync_now (Q1.1 closure) ─────────────────────────────── */
    // Manually trigger a Dataplane sync round-trip from an MCP client.
    // Mirrors POST /api/sync/now. Useful for (a) agents that want to
    // flush the WAL deterministically and (b) smoke-testing the
    // Dataplane binding without curl. Airplane-safe.
    mcpServer.tool(
        'sync_now',
        'Manually trigger a Dataplane sync round-trip. `direction` ∈ {push, pull, both} (default: both). Returns push/pull counts and any errors. Airplane-safe — failure returns a structured error, not an exception.',
        {
            direction: z.enum(['push', 'pull', 'both']).optional().describe('Which leg(s) to run. Default: both.'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async ({ direction, workspace }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                // Postgres-model isolation (2026-06-19): one boot-bound SyncEngine
                // (active workspace's). Refuse a non-active target rather than
                // silently syncing the active workspace under another name.
                {
                    const active = deps.detectedScope?.workspace;
                    if (active && workspace !== active) {
                        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_not_active', requested: workspace, active, hint: 'sync operates on the active workspace only; switch the active workspace to sync another.' }, null, 2) }], isError: true };
                    }
                }
                const dir = direction ?? 'both';
                const payload: Record<string, unknown> = {};
                const sync = deps.getSyncEngine();
                if (dir === 'push' || dir === 'both') {
                    const p = await sync.pushPending();
                    payload['push'] = p;
                }
                if (dir === 'pull' || dir === 'both') {
                    const p = await sync.pullRemote();
                    payload['pull'] = p;
                }
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
                };
            } catch (error) {
                return mcpToolError('register_workspace', error, log);
            }
        },
    );

    /* ─── resolve_deferred (Q1.7) ─────────────────────────────── */
    // Closes a deferred-* Lore node by stamping metadata.resolved_at
    // (and optionally metadata.resolved_by_commit). The node stays in
    // the graph for historical context; subsequent recall() calls skip
    // resolved items in the deferred-sidecar scan.
    mcpServer.tool(
        'resolve_deferred',
        'Mark a deferred-* Lore node as resolved. Stamps metadata.resolved_at (ISO timestamp) and optionally metadata.resolved_by_commit. After resolving, `recall()` no longer auto-surfaces the node.',
        {
            id: z.string().describe('Deferred node ID (must start with "deferred-")'),
            commit: z.string().optional().describe('Optional commit SHA that resolved the deferred work'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async ({ id, commit, workspace }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                // Local-mode (Postgres model) — route the stamp to the
                // REQUESTED workspace's graph, not the boot/active store.
                const resolved = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope?.workspace ?? '',
                    workspace,
                );
                if (!resolved.ok) {
                    if ('missing' in resolved) return workspaceRequiredEnvelope();
                    return workspaceNotFoundEnvelope(resolved.requested, resolved.known);
                }
                const { stampResolved } = await import('../../engines/deferred.js');
                const result = await stampResolved(resolved.graph, id, commit);
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
                return mcpToolError('register_workspace', error, log);
            }
        },
    );

    /* ─── get_hot_context ─────────────────────────────────────── */
    mcpServer.tool(
        'get_hot_context',
        'Retrieve the Hot Cache: the most recently stored or accessed knowledge nodes. Use this to maintain immediate context.',
        {
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async ({ workspace }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (read).
                const scopeDenied = assertMcpScope(workspace, 'read');
                if (scopeDenied) return scopeDenied;
                // Local-mode (Postgres model) — read the REQUESTED workspace's
                // hot cache. sessionCache is a LocalGraph property (mirrors the
                // boot `store.sessionCache` for the active workspace); narrow
                // via cast like resolveTargetTableStorage's getTableStorage().
                const resolved = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope?.workspace ?? '',
                    workspace,
                );
                if (!resolved.ok) {
                    if ('missing' in resolved) return workspaceRequiredEnvelope();
                    return workspaceNotFoundEnvelope(resolved.requested, resolved.known);
                }
                // The hot-session cache is a JSON file keyed on the workspace
                // path; it hung off LocalGraph by accident of ownership. The
                // registry owns it per-workspace now (one instance per
                // hot_session.json — the TW-7e invariant), and the active
                // workspace uses the bundle's, which is that same instance.
                const targetSessionCache: ISessionCache = resolved.isActive || !deps.graphRegistry
                    ? deps.store.sessionCache
                    : await deps.graphRegistry.sessionCacheFor(resolved.resolvedWorkspace);
                const context = targetSessionCache.getHotContext();
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(context, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('register_workspace', error, log);
            }
        },
    );

    /* ─── prune_ephemeral (Fix #5) ────────────────────────────── */
    // Delete expired ephemeral scratchpad nodes. Normally called at
    // daemon startup inside main(); exposed as a tool so agents can
    // trigger it mid-session (e.g. after completing a multi-step skill).
    mcpServer.tool(
        'prune_ephemeral',
        'Delete expired ephemeral scratchpad nodes (ephemeral=true, past their ttl_ms). Normally runs at daemon startup; call this mid-session to reclaim working-memory nodes from a completed multi-step task.',
        {
            defaultTtlMs: z.number().optional().describe('TTL in milliseconds used for nodes that have ttl_ms=0 (not set). Default: 3600000 (1 hour).'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async ({ defaultTtlMs, workspace }) => {
            try {
                if (!workspace || typeof workspace !== 'string' || workspace.length === 0) {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'workspace_required', hint: 'pass workspace=<name>' }, null, 2) }], isError: true };
                }
                // SP-01 — enforce bound-principal workspace scope (write).
                const scopeDenied = assertMcpScope(workspace, 'write');
                if (scopeDenied) return scopeDenied;
                // Local-mode (Postgres model) — prune the REQUESTED workspace's
                // ephemeral nodes, not the boot/active store. pruneEphemeralNodes
                // is a LocalGraph method (the boot storageClient delegates to it);
                // narrow via cast and fall back to the boot storageClient when the
                // resolved graph doesn't expose it (cloud/DataplaneGraph).
                const resolved = await resolveTargetGraph(
                    deps.store,
                    deps.graphRegistry,
                    deps.detectedScope?.workspace ?? '',
                    workspace,
                );
                if (!resolved.ok) {
                    if ('missing' in resolved) return workspaceRequiredEnvelope();
                    return workspaceNotFoundEnvelope(resolved.requested, resolved.known);
                }
                const graph = resolved.graph;
                const ttl = defaultTtlMs ?? 3_600_000;

                // ITEM X-pruneeph (2026-09-03) — SurrealGraph exposes a
                // query-only listExpiredEphemeralNodeIds() so THIS caller
                // can drive the per-node delete itself, through the exact
                // nodeWriteLock / outbox / verbatim-tombstone discipline
                // prune_nodes hard_delete uses (mcp/tools/lifecycle.ts).
                // graph.pruneEphemeralNodes() itself is unchanged and calls
                // deleteNode() directly with none of that — no lock, no
                // outbox row, no verbatim tombstone — orphaning the LanceDB
                // vector row and leaving the outbox blind to the delete.
                // Engines that don't expose the safe query method
                // (DataplaneGraph, ArcadeGraphStore) fall back to the
                // pre-fix direct call — safePruneEphemeralNodes handles that
                // fallback itself. Shared with `POST /api/prune-ephemeral`
                // (mcp/http/routes/retention/policy.ts) and the daemon's
                // boot-time prune (mcp/server.ts) — see
                // engines/safeEphemeralPrune.ts.
                const deleted = await safePruneEphemeralNodes({
                    graph,
                    workspace: resolved.resolvedWorkspace,
                    ttl,
                    outboxStore: deps.outboxStore,
                    initiator: 'mcp:prune_ephemeral',
                    tombstoneVerbatim: async (verbatimId, reason) => {
                        const targetVerbatim = deps.workspaceVerbatimResolver
                            ? await deps.workspaceVerbatimResolver.getOrOpen(resolved.resolvedWorkspace)
                            : deps.store.loreVerbatim;
                        const vstore = targetVerbatim as unknown as {
                            tombstone?: (id: string, reason: string) => Promise<void>;
                        };
                        if (typeof vstore.tombstone === 'function') {
                            await vstore.tombstone(verbatimId, reason);
                        } else {
                            await deps.store.storageClient.verbatimDelete(verbatimId);
                        }
                    },
                    onLog: (message) => console.error(`[Lore MCP] ${message}`),
                });

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            ok: true,
                            deleted,
                            message: deleted > 0
                                ? `Pruned ${deleted} expired ephemeral node(s).`
                                : 'No expired ephemeral nodes found.',
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return mcpToolError('register_workspace', error, log);
            }
        },
    );
}
