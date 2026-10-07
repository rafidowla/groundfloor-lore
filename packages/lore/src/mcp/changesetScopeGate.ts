/**
 * changesetScopeGate.ts — row-level security_scopes gate for changeset
 * commit / rollback (MCP commit_changeset / rollback_changeset and the REST
 * twins). A changeset can write, restore or delete nodes, so a BOUND actor must
 * not drive one that touches a node it cannot see.
 *
 * Rule: if ANY node the changeset touches is hidden from the bound actor, the
 * caller answers exactly as for a missing changeset id and does nothing (no
 * graph write, no version row, no status change). "Touches" is the union of the
 * buffered writes (upsert_node / delete_node) and the version rows already
 * recorded under the changeset id (commit leaves both behind, rollback replays
 * the versions). Each target is gated against the workspace the write goes to
 * (the payload's workspace, which may differ from the changeset's):
 *   - node exists in that graph → mutateTargetVisible;
 *   - node absent (create, or delete of a gone id) → createIdBlockedForCurrentActor,
 *     deny-if-any over its version log and canonical verbatim row, so a deleted
 *     hidden node's id cannot be re-created or have its log overwritten.
 * A workspace that cannot be resolved is skipped (the write fails with
 * workspace_not_found anyway and touches nothing). Any lookup failure fails
 * closed. Unbound caller → false, zero lookups.
 *
 * There is no changeset get/list surface: begin/commit/rollback are the only
 * doors, so nothing else exposes buffered node bodies.
 */

import type { StorageBundle } from './services.js';
import type { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import type { VersionStoreApi } from '../outbox/versionStoreApi.js';
import type { VerbatimStoreApi } from '../engines/verbatimStoreApi.js';
import { resolveTargetGraph } from './tools/workspaceResolve.js';
import { getCurrentActorScopes } from '../security/actorContext.js';
import { buildWriteScopeDeps, createIdBlockedForCurrentActor, mutateTargetVisible } from '../security/writeTargetGate.js';

export interface ChangesetGateDeps {
    store: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    versionStore: VersionStoreApi;
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<VerbatimStoreApi> };
}

/** True when the changeset touches a node hidden from the current bound actor. */
export async function changesetTouchesHiddenNode(changesetId: string, d: ChangesetGateDeps): Promise<boolean> {
    if (getCurrentActorScopes() === undefined) return false;
    try {
        const targets = new Map<string, { workspace: string; nodeId: string }>();
        const add = (workspace: unknown, nodeId: unknown): void => {
            if (typeof workspace !== 'string' || typeof nodeId !== 'string' || nodeId === '') return;
            targets.set(`${workspace}\u0000${nodeId}`, { workspace, nodeId });
        };
        for (const w of await d.versionStore.getChangesetWrites(changesetId)) {
            if (w.operation === 'upsert_node') {
                const p = w.payload as { workspace?: unknown; nodeData?: Record<string, unknown> };
                add(p.workspace, p.nodeData?.['id']);
            } else if (w.operation === 'delete_node') {
                const p = w.payload as { workspace?: unknown; node_id?: unknown };
                add(p.workspace, p.node_id);
            }
        }
        for (const v of await d.versionStore.getVersionsByChangeset(changesetId)) add(v.workspace, v.nodeId);

        for (const { workspace, nodeId } of targets.values()) {
            const g = await resolveTargetGraph(d.store, d.graphRegistry, workspace, workspace);
            if (!g.ok) continue;
            const verbatim = d.workspaceVerbatimResolver ? await d.workspaceVerbatimResolver.getOrOpen(workspace) : undefined;
            const deps = buildWriteScopeDeps({
                workspace, store: d.store, graphRegistry: d.graphRegistry, versionStore: d.versionStore,
                ...(verbatim ? { verbatim } : {}),
            });
            const ids = { nodeId, verbatimId: `lore:${nodeId}` };
            const exists = !!(await g.graph.getNode(nodeId));
            const blocked = exists ? !(await mutateTargetVisible(ids, deps)) : await createIdBlockedForCurrentActor(ids, deps);
            if (blocked) return true;
        }
        return false;
    } catch {
        return true;
    }
}
