/**
 * versionScopeGate.ts — row-level security_scopes confinement for the version
 * log surfaces (node history, workspace diff; REST + MCP). Version rows carry
 * full node bodies, so they must be hidden from a bound actor lacking the
 * node's scopes, exactly like the node itself.
 *
 * Each node is gated by its REAL labels (security/itemScopes.ts), looked up by
 * the EXACT node id — getVersions reads the exact id, so a literal id such as
 * `lore:S` or `S#rev…` is gated on itself, never on node `S`: the live graph
 * node, else its newest version row (so a DELETED node's history resolves from
 * the log itself). Source (c) — the verbatim row — is deliberately not consulted
 * here: a node with no live graph node and no version row has no version rows to
 * return, so there is nothing for it to gate.
 *
 * Allowed actors get the full, untrimmed history. Hidden nodes' rows are
 * dropped, never the whole response. Unbound actor (no actor context) → no
 * filtering and no lookups. Filtering is at the route/tool layer only; the
 * version store itself is unchanged.
 */

import type { StorageBundle } from '../services.js';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import type { VersionStoreApi } from '../../outbox/versionStoreApi.js';
import { resolveTargetGraph } from './workspaceResolve.js';
import { itemVisibleToCurrentActor, resolveItemScopes, type ItemScopeDeps } from '../../security/itemScopes.js';
import { getCurrentActorScopes } from '../../security/actorContext.js';

export interface VersionGateDeps {
    store: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    versionStore: Pick<VersionStoreApi, 'getVersions'>;
}

function scopeDeps(d: VersionGateDeps, workspace: string): ItemScopeDeps {
    return {
        workspace,
        getGraphNode: async (nodeId) => {
            // '' = legacy/direct-call bypass with no workspace: the boot graph.
            if (workspace === '') return d.store.loreGraph.getNode(nodeId);
            const g = await resolveTargetGraph(d.store, d.graphRegistry, workspace, workspace);
            if (!g.ok) return null;
            return g.graph.getNode(nodeId);
        },
        versionStore: d.versionStore,
    };
}

/** May the current actor see the version history of `nodeId`? Unbound actor → true. */
export async function nodeHistoryVisible(nodeId: string, workspace: string, d: VersionGateDeps): Promise<boolean> {
    if (getCurrentActorScopes() === undefined) return true;
    return itemVisibleToCurrentActor(await resolveItemScopes({ nodeId }, scopeDeps(d, workspace)));
}

/** Drop version rows for nodes the current actor may not see. Unbound actor → rows unchanged. */
export async function filterVersionsByActorScope<T extends { nodeId: string }>(rows: T[], workspace: string, d: VersionGateDeps): Promise<T[]> {
    if (getCurrentActorScopes() === undefined || rows.length === 0) return rows;
    const sd = scopeDeps(d, workspace);
    const ids = [...new Set(rows.map((r) => r.nodeId))];
    const visible = new Set<string>();
    const CONCURRENCY = 16;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
        await Promise.all(ids.slice(i, i + CONCURRENCY).map(async (id) => {
            if (itemVisibleToCurrentActor(await resolveItemScopes({ nodeId: id }, sd))) visible.add(id);
        }));
    }
    return rows.filter((r) => visible.has(r.nodeId));
}
