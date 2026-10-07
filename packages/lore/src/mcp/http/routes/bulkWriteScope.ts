/**
 * bulkWriteScope.ts — row-level security_scopes gate for the bulk write routes
 * (POST /api/nodes/bulk, /api/nodes/bulk-delete, /api/edges/bulk). Split out of
 * bulkWrite.ts (file-size cap).
 *
 * A BOUND actor must not be able to tell a node it cannot see from a node that
 * does not exist, and must not alter one:
 *   - bulk upsert: every item id is caller-chosen, so a hidden (or hidden-and-
 *     deleted) id is refused per item with the neutral id_unavailable error;
 *   - bulk-delete: a hidden id is reported exactly like a missing one
 *     (`{ok:true, deleted:false}`, counted in `notFound`) and never reaches the
 *     outbox or the graph;
 *   - bulk edges: an edge with a hidden endpoint gets the very
 *     `edge_endpoint_missing` error an edge with a missing endpoint gets.
 * Unbound callers (local mode, embedded hosts) are never filtered and cause no
 * lookups. Visibility itself is decided by security/writeTargetGate.ts.
 */

import { assertSafeLanceId } from '../../../engines/verbatimHistory.js';
import { buildWriteScopeDeps } from '../../../security/writeTargetGate.js';
import { ID_UNAVAILABLE, ID_UNAVAILABLE_MESSAGE } from '../../../security/writeTargetGate.js';
import { blockedCreateIdsForCurrentActor, visibleMutateIdsForCurrentActor } from '../../../security/writeTargetBatch.js';
import { rowOwnScopes, type ItemScopeDeps } from '../../../security/itemScopes.js';
import { normalizeScopes } from '../../../security/scopeFilter.js';
import type { BulkWriteDeps } from './bulkWrite.js';

/** Per-item error string for a refused create id (route convention: `code: message`). */
export const ID_UNAVAILABLE_ITEM_ERROR = `${ID_UNAVAILABLE}: ${ID_UNAVAILABLE_MESSAGE}`;

/** ItemScopeDeps for the workspace the bulk write lands in (REST handles: store, registry, version store, verbatim). */
export function bulkScopeDeps(
    deps: BulkWriteDeps,
    workspace: string,
    verbatim?: { getById?: (id: string) => Promise<{ security_scopes?: unknown } | null | undefined> },
): ItemScopeDeps {
    return buildWriteScopeDeps({
        workspace, store: deps.store, graphRegistry: deps.graphRegistry,
        versionStore: deps.versionStore, verbatim,
    });
}

/** Only ids that pass the LanceDB-safe check are ever looked up (the verbatim lookup builds a where() predicate). */
function lookupSafe(ids: unknown[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
        if (typeof id !== 'string') continue;
        try { assertSafeLanceId(id, 'bulkWriteScope'); out.push(id); } catch { /* shape gate rejects it per item */ }
    }
    return out;
}

/** Item ids of a bulk upsert the current actor must be refused. Unbound → empty set, zero lookups. */
export function blockedBulkUpsertIds(ids: unknown[], sd: ItemScopeDeps): Promise<Set<string>> {
    return blockedCreateIdsForCurrentActor(lookupSafe(ids), sd);
}

/**
 * Of the (prefix-stripped) node ids of a bulk-delete, the ones the actor may
 * delete. null = unbound (everything). Ids outside the safe charset resolve to
 * "not visible" without a lookup — the delete would be a no-op for them anyway.
 */
export function deletableBulkIds(strippedIds: string[], sd: ItemScopeDeps): Promise<Set<string> | null> {
    return visibleMutateIdsForCurrentActor(lookupSafe(strippedIds), sd);
}

/** The engine's own wording for a missing edge endpoint (sqliteGraphWrites.addEdge / dataplaneEdgeShape). */
export function edgeEndpointMissingMessage(sourceId: string, targetId: string, sourceOk: boolean, targetOk: boolean): string {
    const which = [
        sourceOk ? null : `source '${sourceId}'`,
        targetOk ? null : `target '${targetId}'`,
    ].filter(Boolean).join(' and ');
    return `[LoreGraph:addEdge] edge_endpoint_missing: ${which} not found — the node must be written (and committed) before its edges`;
}

/**
 * For a bound actor: the endpoint ids (of all plans) that exist AND are visible.
 * null = unbound. An endpoint absent from the set is reported as missing.
 */
export function visibleEdgeEndpoints(edges: Array<{ sourceId: string; targetId: string }>, sd: ItemScopeDeps): Promise<Set<string> | null> {
    return visibleMutateIdsForCurrentActor(lookupSafe(edges.flatMap((e) => [e.sourceId, e.targetId])), sd);
}

/**
 * The scopes node `id` holds after this item's write, for its question-alias rows (they must
 * carry the node's own scopes, bound or not). The live node first; when its rows carry none
 * (ARCADE keeps scopes on the canonical verbatim row only) the canonical row's own scopes. A
 * node found in neither source has no stored scopes (`[]`). `undefined` = a lookup threw, so the
 * scopes are unknown and callers write no alias rows (fail closed, never public).
 */
export function storedScopesResolver(scopeDeps: ItemScopeDeps, id: string): () => Promise<string[] | undefined> {
    return async () => {
        try {
            const n = await scopeDeps.getGraphNode?.(id);
            const own = n ? normalizeScopes(n.security_scopes) : [];
            if (own.length > 0 || !scopeDeps.getVerbatimRow) return own;
            return rowOwnScopes(await scopeDeps.getVerbatimRow(`lore:${id}`)) ?? own;
        } catch {
            return undefined;
        }
    };
}
