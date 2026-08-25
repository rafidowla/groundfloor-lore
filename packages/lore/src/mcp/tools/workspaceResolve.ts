/**
 * workspaceResolve.ts — Sprint L1b workspace-resolution helper for MCP tools.
 *
 * Extracted from memory.ts during the L1b sweep so the file stayed
 * under the 800-line cap. Every MCP write/read tool that targets a
 * specific workspace's `.lore/graph` dir routes through this helper.
 *
 * Contract (post-L1b):
 *   - `workspace` argument is REQUIRED. Callers that pass undefined or
 *     empty string receive `{ ok: false, missing: true }` and must
 *     surface a `workspace_required` MCP error envelope.
 *   - Unknown workspace → `{ ok: false, requested, known }` for the
 *     `workspace_not_found` envelope.
 *   - Registry absent (cloud-mode / tests) → resolution returns the
 *     boot-bound `store.loreGraph`, but still requires the workspace
 *     argument to be present.
 */

import type { StorageBundle } from '../services.js';
import type { ITableStorage } from '../../contracts/tables.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../engines/localGraphRegistry.js';

export type GraphResolution =
    | { ok: true; graph: StorageBundle['loreGraph']; resolvedWorkspace: string; isActive: boolean }
    | { ok: false; requested: string; known: string[] }
    | { ok: false; missing: true };

export async function resolveTargetGraph(
    store: StorageBundle,
    registry: LocalGraphRegistry | undefined,
    _activeWorkspace: string,
    requested: string | undefined,
): Promise<GraphResolution> {
    if (!requested || requested.length === 0) {
        return { ok: false, missing: true };
    }
    if (!registry) {
        return { ok: true, graph: store.loreGraph, resolvedWorkspace: requested, isActive: true };
    }
    try {
        // getGraphHandle, not getOrOpen: the latter is the KÙZU substrate
        // accessor and returns a LocalGraph for every workspace, so a
        // Surreal-backed one read and wrote an empty Kùzu database and
        // reported success. getGraphHandle resolves the declared engine, and
        // goes through getOrOpen first so the workspace-confinement gate
        // (assertWorkspaceOpenAllowed) still runs on this path.
        const g = await registry.getGraphHandle(requested);
        return {
            ok: true,
            graph: g as unknown as StorageBundle['loreGraph'],
            resolvedWorkspace: requested,
            isActive: g === store.loreGraph,
        };
    } catch (err) {
        if (err instanceof WorkspaceNotFoundError) {
            return { ok: false, requested: err.requested, known: err.known };
        }
        throw err;
    }
}

/**
 * resolveTargetTableStorage — per-workspace ITableStorage routing
 * (2026-06-19, Postgres-model isolation). Collections live in Kùzu's table
 * storage, which is `LocalGraph.getTableStorage()`. So routing a collection op
 * to the requested workspace is just resolving that workspace's graph and
 * taking its table storage — no separate registry needed. Same contract as
 * resolveTargetGraph: missing workspace → {ok:false,missing}; unknown →
 * {ok:false,requested,known}; registry absent → boot store.
 */
export type TableResolution =
    | { ok: true; tableStorage: ITableStorage; resolvedWorkspace: string; isActive: boolean }
    | { ok: false; requested: string; known: string[] }
    | { ok: false; missing: true };

export async function resolveTargetTableStorage(
    store: StorageBundle,
    registry: LocalGraphRegistry | undefined,
    activeWorkspace: string,
    requested: string | undefined,
): Promise<TableResolution> {
    const res = await resolveTargetGraph(store, registry, activeWorkspace, requested);
    if (!res.ok) return res;
    // Table storage is NOT a graph concept — it is a SQLite file keyed on the
    // workspace path. It used to be reached by casting the graph handle to
    // something with `getTableStorage()`, which quietly required the workspace
    // to be Kùzu-backed. The registry owns it now; the active workspace has no
    // registry entry, so it uses the bundle's, which is the same file.
    const ts = registry && !res.isActive
        ? await registry.tableStorageFor(res.resolvedWorkspace)
        : store.tableStorage;
    return { ok: true, tableStorage: ts, resolvedWorkspace: res.resolvedWorkspace, isActive: res.isActive };
}

/**
 * workspaceRequiredEnvelope — Sprint L1b canonical MCP-tool error
 * when a workspace argument is missing. Mirrors the REST 400 shape.
 */
export function workspaceRequiredEnvelope(): { content: Array<{ type: 'text'; text: string }>; isError: true } {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({
                error: 'workspace_required',
                hint: 'pass workspace=<name> as a tool argument',
            }, null, 2),
        }],
        isError: true,
    };
}
