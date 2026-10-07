/**
 * writeTargetGate.ts — shared row-level security_scopes gate for WRITE paths
 * (REST routes and MCP tools). The read paths already hide an item from a
 * BOUND actor that lacks its scopes (security/itemScopes.ts); writes must obey
 * the same rule, or a write response / side effect reveals or alters an item
 * the actor cannot see.
 *
 * Bound vs unbound. A BOUND actor is one with `getCurrentActorScopes() !==
 * undefined`. An UNBOUND caller (local mode, embedded host, stdio MCP,
 * daemon-internal) is never filtered and both helpers return immediately with
 * ZERO lookups.
 *
 * Two semantics, one per kind of write:
 *
 *  - mutateTargetVisible — operations on an EXISTING item (update, delete,
 *    supersede, mark-stale, edge endpoint, outcome). The item is resolved with
 *    resolveItemScopes (live node → newest version row → canonical verbatim
 *    row) and must be visible. A nonexistent id resolves `unknown` → false, so
 *    the caller returns its ordinary not-found response, which is what it
 *    returns for a missing id anyway: hidden is indistinguishable from missing.
 *
 *  - createIdBlockedForCurrentActor — create/upsert with a CALLER-CHOSEN id.
 *    DENY-IF-ANY: every available source is consulted and the id is blocked if
 *    ANY present source has scopes the actor cannot see. Re-creating a deleted
 *    hidden node's id would otherwise make its old hidden version history
 *    readable (history visibility resolves from the live node first). Absent
 *    sources do not block; a source whose lookup throws, or a verbatim row
 *    whose scopes are damaged/absent, FAILS CLOSED (blocked).
 *
 * Refusal shape. A blocked create must answer with ID_UNAVAILABLE /
 * ID_UNAVAILABLE_MESSAGE: neutral wording that says nothing about scopes,
 * permissions, hidden rows or existence.
 *
 * Which handles to pass to buildWriteScopeDeps:
 *  - REST route: `deps.store`, `deps.graphRegistry`, `deps.versionStore`, and
 *    the workspace's verbatim store (`{ getById }`) when the route has one.
 *  - MCP tool:   the tool's `deps.store`, `deps.graphRegistry`,
 *    `deps.versionStore`, and the verbatim store's `getById` when registered.
 *  Omit a handle the caller truly lacks; that source is then skipped. For
 *  create gates prefer passing every handle — more sources means a stricter,
 *  not weaker, gate.
 */

import type { StorageBundle } from '../mcp/services.js';
import type { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import { resolveTargetGraph } from '../mcp/tools/workspaceResolve.js';
import { getCurrentActorScopes } from './actorContext.js';
import { normalizeScopes } from './scopeFilter.js';
import {
    isDamagedScopes,
    itemVisibleToCurrentActor,
    resolveItemScopes,
    scopesVisibleToCurrentActor,
    stateScopes,
    type ItemIds,
    type ItemScopeDeps,
} from './itemScopes.js';

/** Error code for a refused create/upsert id. Deliberately uninformative. */
export const ID_UNAVAILABLE = 'id_unavailable';
/** Neutral refusal message: no mention of scopes, permissions, hidden rows or existence. */
export const ID_UNAVAILABLE_MESSAGE = 'This id is not available. Choose a different id.';

/** May the current actor operate on this EXISTING item? Unbound → true, no lookups. */
export async function mutateTargetVisible(ids: ItemIds, deps: ItemScopeDeps): Promise<boolean> {
    if (getCurrentActorScopes() === undefined) return true;
    return itemVisibleToCurrentActor(await resolveItemScopes(ids, deps));
}

/**
 * Must the current actor be refused this caller-chosen create id? Unbound →
 * false, no lookups. Bound: deny-if-any across live node, newest version row
 * and canonical verbatim row (`lore:<nodeId>` unless `ids.verbatimId` is given).
 */
export async function createIdBlockedForCurrentActor(ids: ItemIds, deps: ItemScopeDeps): Promise<boolean> {
    if (getCurrentActorScopes() === undefined) return false;
    const { nodeId } = ids;
    const verbatimId = ids.verbatimId ?? `lore:${nodeId}`;
    try {
        // (a) live graph node
        if (deps.getGraphNode) {
            const node = await deps.getGraphNode(nodeId);
            if (node && !scopesVisibleToCurrentActor(normalizeScopes(node.security_scopes))) return true;
        }
        // (b) newest version row; a state without a security_scopes key is "no info"
        if (deps.versionStore) {
            const rows = (await deps.versionStore.getVersions(nodeId, deps.workspace, 1)) as Array<{ newState?: unknown; previousState?: unknown }> | undefined;
            const newest = rows?.[0];
            if (newest) {
                const scopes = stateScopes(newest.newState) ?? stateScopes(newest.previousState);
                if (scopes && !scopesVisibleToCurrentActor(scopes)) return true;
            }
        }
        // (c) canonical verbatim row: damaged or absent labels fail closed
        if (deps.getVerbatimRow) {
            const row = await deps.getVerbatimRow(verbatimId);
            if (row) {
                const raw = row.security_scopes;
                if (raw === undefined || raw === null || isDamagedScopes(raw)) return true;
                if (!scopesVisibleToCurrentActor(normalizeScopes(raw))) return true;
            }
        }
    } catch {
        return true;
    }
    return false;
}

export interface WriteScopeHandles {
    /** Workspace the write targets (the version-store key). '' = boot graph (legacy/direct-call bypass). */
    workspace: string;
    store: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    versionStore?: ItemScopeDeps['versionStore'];
    /** Verbatim store of that workspace; only `getById` is used. */
    verbatim?: { getById?: (id: string) => Promise<{ security_scopes?: unknown } | null | undefined> };
}

/** ONE factory turning a caller's handles into ItemScopeDeps for the gates above. */
export function buildWriteScopeDeps(h: WriteScopeHandles): ItemScopeDeps {
    const getById = h.verbatim?.getById?.bind(h.verbatim);
    return {
        workspace: h.workspace,
        getGraphNode: async (nodeId) => {
            if (h.workspace === '') return h.store.loreGraph.getNode(nodeId);
            const g = await resolveTargetGraph(h.store, h.graphRegistry, h.workspace, h.workspace);
            // Unresolvable workspace → throw so the create gate fails closed
            // (mutate also resolves `unknown`); never read as "no such node".
            if (!g.ok) throw new Error('workspace_unresolvable');
            return g.graph.getNode(nodeId);
        },
        ...(h.versionStore ? { versionStore: h.versionStore } : {}),
        ...(getById ? { getVerbatimRow: (id: string) => getById(id) } : {}),
    };
}
