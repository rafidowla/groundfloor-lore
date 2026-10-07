/**
 * itemScopes.ts — resolve the REAL security_scopes of an item (a node and its
 * verbatim/history rows) so direct-read and history routes can apply the same
 * row-level confinement the graph-read routes already apply.
 *
 * Why this exists. `security_scopes` is enforced per row ("even within a
 * workspace this user is allowed to read" — security/scopeFilter.ts). The
 * 2026-08-17 remediation confined graph reads (GET /api/node, node-full, …).
 * Verbatim get/history and node/workspace version history were missed: they
 * returned text and full node bodies for rows the actor's scopes should hide.
 * Verbatim `getHistory` entries and version rows carry no (reliable) labels of
 * their own, so history is gated by the item's CURRENT labels:
 *
 *   (a) the live graph node's `security_scopes`, if the node exists;
 *   (b) else the newest node_versions row for that node (new_state, or
 *       previous_state for a delete row whose new_state is null) — this is how
 *       a deleted node's history stays reachable for allowed actors and hidden
 *       from the rest;
 *   (c) else the canonical verbatim row's scopes — but only if undamaged. A row
 *       whose scopes are non-empty and every entry === 'undefined' is the
 *       pre-3.28 Lance write bug (a scoped row stored as the string
 *       "undefined"); its real labels are lost, so it is `unknown`.
 *
 * `unknown` is hidden from a bound actor and visible to an unbound one.
 * An unbound actor (getCurrentActorScopes() === undefined: local mode without
 * operator.json, embedded, daemon-internal) is never filtered.
 *
 * Matching is NOT reimplemented here: visibility goes through
 * applyActorScopeFilter, so fail-closed semantics are identical everywhere.
 *
 * Filtering happens at the route / tool layer, never inside the stores —
 * internal callers (dedupe, skip-identical, reconnect, migrations, export) must
 * keep seeing every row.
 */

import { applyActorScopeFilter, normalizeScopes } from './scopeFilter.js';
import { getCurrentActorScopes } from './actorContext.js';
import { isRevisionHistoryId } from '../engines/verbatimHistory.js';

export type ItemScopes = { scopes: string[] } | { unknown: true };

export interface ItemScopeDeps {
    /** Workspace the item lives in (the version-store key). */
    workspace: string;
    /** Live graph node lookup by bare node id. Absent → source (a) skipped. */
    getGraphNode?: (nodeId: string) => Promise<{ security_scopes?: unknown } | null | undefined>;
    /** Version log accessor (local VersionStore or cloud DataplaneVersionStore). Absent → source (b) skipped. */
    versionStore?: { getVersions(nodeId: string, workspace: string, limit?: number): unknown };
    /** Canonical verbatim row lookup by exact verbatim id. Absent → source (c) skipped. */
    getVerbatimRow?: (verbatimId: string) => Promise<{ security_scopes?: unknown } | null | undefined>;
}

/** Bare graph node id for a node id, `lore:<id>` canonical verbatim id or `<id>#rev<ts>` history id. */
export function baseNodeId(id: string): string {
    let base = id;
    if (isRevisionHistoryId(base)) base = base.replace(/#rev[^#]*$/, '');
    return base.startsWith('lore:') ? base.slice(5) : base;
}

/** Pre-3.28 Lance bug: scopes stored as the literal string 'undefined'. Non-empty and all 'undefined'. */
export function isDamagedScopes(raw: unknown): boolean {
    if (!Array.isArray(raw) || raw.length === 0) return false;
    return raw.every((s) => s === 'undefined');
}

/** True when the bound actor may see a row labelled `scopes` (reuses applyActorScopeFilter). */
export function scopesVisibleToCurrentActor(scopes: unknown): boolean {
    const actor = getCurrentActorScopes();
    if (actor === undefined) return true;
    return applyActorScopeFilter([{ metadata: { security_scopes: normalizeScopes(scopes) as string[] } }], actor).length === 1;
}

/** Is an item resolved by resolveItemScopes visible to the current actor? */
export function itemVisibleToCurrentActor(item: ItemScopes): boolean {
    if (getCurrentActorScopes() === undefined) return true;
    if ('unknown' in item) return false;
    return scopesVisibleToCurrentActor(item.scopes);
}

function stateScopes(state: unknown): string[] | undefined {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) return undefined;
    // An ABSENT security_scopes key says nothing about the node's labels (a
    // partial/legacy state object): it must not be read as "public". Return
    // undefined so resolution falls through to previousState, then to the next
    // source, then `unknown`. A PRESENT key (including an empty array) is an
    // explicit label set; an empty one is public.
    if (!('security_scopes' in state) || (state as { security_scopes?: unknown }).security_scopes === undefined) return undefined;
    return normalizeScopes((state as { security_scopes?: unknown }).security_scopes);
}

/** The two distinct ids an item is looked up by. */
export interface ItemIds {
    /** EXACT id of the graph node / version-log key (what getNode / getVersions read). Never normalised. */
    nodeId: string;
    /** Exact verbatim row id (`lore:<id>` form); used only for source (c). */
    verbatimId?: string;
}

/**
 * Resolve the real labels of an item. Pass `{ nodeId, verbatimId }` to look the
 * graph node and version log up by the EXACT node id (so a literal id such as
 * `lore:S` or `S#rev…` is never conflated with node `S`) while the verbatim row
 * is looked up by its own id. A bare string is the verbatim-side convenience
 * form: a canonical verbatim id (`lore:<node>`), a history id, or a bare node
 * id — the node id is derived with baseNodeId and the verbatim lookup uses the
 * string minus any `#rev` suffix. Callers that start from a bare node id and
 * want source (c) must pass `lore:<id>`. A failure in any consulted source
 * fails CLOSED (`unknown`): falling through to a weaker source after an error
 * could widen visibility.
 */
export async function resolveItemScopes(id: string | ItemIds, deps: ItemScopeDeps): Promise<ItemScopes> {
    const nodeId = typeof id === 'string' ? baseNodeId(id) : id.nodeId;
    const verbatimId = typeof id === 'string'
        ? (isRevisionHistoryId(id) ? id.replace(/#rev[^#]*$/, '') : id)
        : id.verbatimId;

    // (a) live graph node
    if (deps.getGraphNode) {
        try {
            const node = await deps.getGraphNode(nodeId);
            if (node) return { scopes: normalizeScopes(node.security_scopes) };
        } catch {
            return { unknown: true };
        }
    }

    // (b) newest version row
    if (deps.versionStore) {
        try {
            const rows = (await deps.versionStore.getVersions(nodeId, deps.workspace, 1)) as Array<{ newState?: unknown; previousState?: unknown }> | undefined;
            const newest = rows?.[0];
            if (newest) {
                const fromState = stateScopes(newest.newState) ?? stateScopes(newest.previousState);
                if (fromState) return { scopes: fromState };
            }
        } catch {
            return { unknown: true };
        }
    }

    // (c) canonical verbatim row (undamaged only)
    if (deps.getVerbatimRow && verbatimId !== undefined) {
        try {
            const row = await deps.getVerbatimRow(verbatimId);
            if (row) {
                const raw = row.security_scopes;
                if (raw === undefined || raw === null || isDamagedScopes(raw)) return { unknown: true };
                return { scopes: normalizeScopes(raw) };
            }
        } catch {
            return { unknown: true };
        }
    }

    return { unknown: true };
}

/**
 * The verbatim row's OWN scopes, for a deny-if-either check. Returns undefined
 * when the row has no usable labels (absent, damaged, or the backend does not
 * report them) — the item scopes then decide alone.
 */
export function rowOwnScopes(row: { security_scopes?: unknown } | null | undefined): string[] | undefined {
    if (!row) return undefined;
    const raw = row.security_scopes;
    if (raw === undefined || raw === null || isDamagedScopes(raw)) return undefined;
    return normalizeScopes(raw);
}

/**
 * Combined gate for verbatim reads: the item's real scopes AND the row's own
 * undamaged scopes must both allow. Never widens. Unbound actor → true.
 */
export async function verbatimItemVisible(
    id: string,
    row: { security_scopes?: unknown } | null | undefined,
    deps: ItemScopeDeps,
): Promise<boolean> {
    if (getCurrentActorScopes() === undefined) return true;
    if (!itemVisibleToCurrentActor(await resolveItemScopes(id, deps))) return false;
    const own = rowOwnScopes(row);
    return own === undefined || scopesVisibleToCurrentActor(own);
}
