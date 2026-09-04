/**
 * stats.ts — graph/corpus count routes.
 *
 *   POST /api/admin/stats   — cross-workspace global view (admin-gated)
 *   GET  /api/stats         — workspace-scoped counts
 *   GET  /api/capabilities  — machine capability probe (first-run wizard)
 */

import type { ServerResponse } from 'node:http';
import { WorkspaceNotFoundError } from '../../../../engines/localGraphRegistry.js';
import { bindDaemonOperatorLane, bindRouteTarget } from '../../../../security/routeWorkspaceBinding.js';
import { probeFullCapabilities } from '../../../../engines/extractors/qualityAdvisor.js';
import { getActiveWorkspaceName, listWorkspaceNames } from '../../../../config/workspaces.js';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { writeWorkspaceRequired, extractWorkspace, writeError, writeGraphEngineError } from '../../helpers.js';
import { type DiagnosticDeps, type LoreGraph, readWorkspaceStats } from './shared.js';
import { redactError } from '../../../../security/logRedact.js';
import { hasLanguageBreakdown } from '../../../tools/search/helpers.js';
import { CloudModeUnsupportedError } from '../../../../engines/cloudModeUnsupportedError.js';

/**
 * One workspace's entry in `/api/admin/stats`'s `byWorkspace` map. Healthy
 * workspaces (and the registry-race `workspace_not_found` case) keep the
 * original numeric-counts shape; any other error (e.g.
 * `LegacyGraphEngineRemovedError`) carries null counts plus `error` instead
 * of being silently zeroed — see the `errors` catch block below.
 */
type AdminStatsWorkspaceEntry =
    | { nodeCount: number; edgeCount: number }
    | { nodeCount: null; edgeCount: null; error: { code: string; message: string } };

/**
 * Read the corpus language breakdown from whatever graph we were handed.
 *
 * Probes the METHOD, not the engine family. `LocalGraph`, `SurrealGraph` and
 * `DataplaneGraph` all implement `getLanguageBreakdown`; only the Arcade scoped
 * handle does not, which is why it is not on `LoreGraphHandle`. An earlier pass
 * of the daemon engine port gated this behind `requireWorkspaceGraph` — that
 * refuses anything without `bulkListProjected`, i.e. it would have started
 * 501-ing this field in CLOUD mode, where it has always worked.
 */
async function readLanguageBreakdown(graph: unknown, operation: string): Promise<Record<string, number>> {
    if (!hasLanguageBreakdown(graph)) {
        throw new CloudModeUnsupportedError(operation, 'this graph exposes no language aggregate');
    }
    return graph.getLanguageBreakdown();
}

export async function handleAdminStats(res: ServerResponse, deps: DiagnosticDeps): Promise<void> {
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane ?? null },
        { permission: 'administer' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return; }
    // D-021 — /api/admin/stats is a daemon-wide enumeration (iterates every
    // known workspace via the registry below), so it runs in the
    // daemon-operator lane rather than a single-workspace bind.
    if (!bindDaemonOperatorLane(res, { intent: 'read' })) return;
    try {
        // Unscoped totals — touches the boot-bound LocalGraph (in local mode each workspace has its own graph store (.lore/graph or .lore/surreal), so this is the
        // ACTIVE workspace's graph; the byWorkspace block below
        // iterates the registry to surface every workspace's counts).
        const graphStats = await deps.store.storageClient.getStats();
        let languageBreakdown: Record<string, number>;
        try {
            languageBreakdown = await readLanguageBreakdown(deps.store.loreGraph, 'admin_stats_language_breakdown');
        } catch (err) {
            if (err instanceof CloudModeUnsupportedError) {
                writeError(res, err.status, err.code, err.message, { operation: err.operation });
                return;
            }
            throw err;
        }
        // INTENTIONALLY boot/active-scoped: /api/admin/stats runs in the
        // daemon-operator lane (all-workspaces view) and the per-workspace
        // breakdown is assembled below by iterating the registry. This top-level
        // verbatim count is the active workspace's own LanceDB total — not a
        // per-request workspace read, so it stays on the boot storageClient
        // (not a P2 per-workspace routing site).
        const verbatimDocuments = await deps.store.storageClient.verbatimCount();

        // Per-workspace breakdown. When graphRegistry is wired,
        // iterate every known workspace name and read stats off its
        // own LocalGraph. Cloud mode (no registry) returns just the
        // active-workspace numbers under the active name.
        const byWorkspace: Record<string, AdminStatsWorkspaceEntry> = {};
        let totalNodes = 0;
        let totalEdges = 0;
        let errorCount = 0;
        if (deps.graphRegistry) {
            const names = listWorkspaceNames();
            for (const name of names) {
                try {
                    const g = await deps.graphRegistry.getGraphHandle(name);
                    const s = await readWorkspaceStats(g, name);
                    byWorkspace[name] = { nodeCount: s.nodeCount, edgeCount: s.edgeCount };
                    totalNodes += s.nodeCount;
                    totalEdges += s.edgeCount;
                } catch (err) {
                    if (err instanceof WorkspaceNotFoundError) {
                        // workspace_not_found mid-iteration (workspaces.json
                        // edit race) — surface as zeros, don't fail the call.
                        byWorkspace[name] = { nodeCount: 0, edgeCount: 0 };
                        continue;
                    }
                    // Round-E fix (2026-09-04) — any other error (most
                    // notably LegacyGraphEngineRemovedError: a workspace
                    // whose workspaces.json still declares the removed
                    // legacy graph engine, see graphEngineSelector.ts) must
                    // NOT be reported as an empty workspace — that hides a
                    // workspace with real data behind a false all-zero
                    // reading. Surface it as a per-workspace error entry
                    // (null counts, redacted message) and bump the
                    // top-level `errors` count so a caller scanning
                    // byWorkspace for zeros can't miss it.
                    errorCount++;
                    const code = (err as { code?: unknown }).code;
                    byWorkspace[name] = {
                        nodeCount: null,
                        edgeCount: null,
                        error: { code: typeof code === 'string' ? code : 'internal_error', message: redactError(err) },
                    };
                }
            }
        } else {
            const active = getActiveWorkspaceName();
            byWorkspace[active] = { nodeCount: graphStats.nodeCount ?? 0, edgeCount: graphStats.edgeCount ?? 0 };
            totalNodes = graphStats.nodeCount ?? 0;
            totalEdges = graphStats.edgeCount ?? 0;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            scope: 'all-workspaces',
            ...graphStats,
            verbatimDocuments,
            languageBreakdown,
            byWorkspace,
            errors: errorCount,
            globalTotals: { nodeCount: totalNodes, edgeCount: totalEdges },
        }));
    } catch (statsErr) {
        writeError(res, 500, 'internal_error', redactError(statsErr));
    }
}

export async function handleStats(res: ServerResponse, url: string, deps: DiagnosticDeps): Promise<void> {
    try {
        const u = new URL(url, 'http://x');
        const requested = extractWorkspace(null, u.searchParams);
        if (!requested) {
            writeWorkspaceRequired(res);
            return;
        }
        // R4 #5 — token-scoped read gate. handleStats serves the REQUESTED
        // workspace's corpus counts + type/language breakdown, but gateRoute
        // ('read') is a no-op for reads in local mode, so without this a token
        // bound to workspace A could read workspace B's stats. Mirrors
        // corpus.ts. Null principal = legacy/local bypass.
        if (bindRouteTarget(res, { requested, intent: 'read' }) === null) return;
        // Resolve workspace-specific graph via registry. Cloud mode
        // (no registry) falls back to the boot-bound graph but still
        // enforces the workspace_required guard above.
        let targetGraph: LoreGraph = deps.store.loreGraph;
        if (deps.graphRegistry) {
            try {
                targetGraph = await deps.graphRegistry.getGraphHandle(requested);
            } catch (err) {
                if (err instanceof WorkspaceNotFoundError) {
                    writeError(res, 404, 'workspace_not_found', `workspace "${err.requested}" not found`, { requested: err.requested, known: err.known });
                    return;
                }
                // Round-S fix (2026-09-04, finding 3 addendum) — see
                // writeGraphEngineError (mcp/http/helpers.ts): a legacy
                // graphEngine declaration used to fall through to this
                // handler's own generic 500, losing its 501 status/code.
                if (writeGraphEngineError(res, err)) return;
                throw err;
            }
        }
        // Sprint L5b-final — pass the requested workspace as a
        // project filter so alias workspaces sharing an on-disk
        // path with another workspace see only their tagged rows.
        const graphStats = await (targetGraph as { getStats: (p?: string) => ReturnType<typeof targetGraph.getStats> }).getStats(requested);
        let languageBreakdown: Record<string, number>;
        try {
            languageBreakdown = await readLanguageBreakdown(targetGraph, 'stats_language_breakdown');
        } catch (err) {
            if (err instanceof CloudModeUnsupportedError) {
                writeError(res, err.status, err.code, err.message, { operation: err.operation });
                return;
            }
            throw err;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            workspace: requested,
            scope: 'workspace',
            ...graphStats,
            // Verbatim store is global (id-keyed; per-workspace
            // verbatim is a separate concern per L2 spec) — surface
            // it with a `_global` suffix so consumers see it isn't
            // narrowed to the requested workspace.
            verbatimDocuments_global: await deps.store.storageClient.verbatimCount(),
            languageBreakdown,
        }));
    } catch (statsErr) {
        writeError(res, 500, 'internal_error', redactError(statsErr));
    }
}

export async function handleCapabilities(res: ServerResponse): Promise<void> {
    try {
        const caps = await probeFullCapabilities();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(caps));
    } catch (capErr) {
        writeError(res, 500, 'internal_error', redactError(capErr));
    }
}
