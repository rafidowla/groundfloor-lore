/**
 * nodePointers.ts — hide pointers to nodes a bound actor cannot see.
 *
 * Row-level `security_scopes` hide a node from a bound actor. A VISIBLE node,
 * though, can carry a pointer to a hidden one: `supersededBy` holds the
 * successor's id, and `supersededReason` is free text written alongside it.
 * Returning the visible node verbatim leaks the hidden node's id (ids are not
 * secret to the person who may not see the node — that is the point of hiding
 * it) and proves the hidden node exists.
 *
 * Contract (bound actors only): a pointer to a node the actor cannot see is
 * presented as if that node did not exist. We make "hidden" and "missing"
 * indistinguishable by treating them IDENTICALLY — one rule, no branch on why
 * the target was not found:
 *
 *   - target visible to the actor        → pointer unchanged
 *   - target hidden OR deleted/absent    → `supersededBy: null`,
 *                                          `supersededReason: null`;
 *                                          `supersededAt` is kept
 *
 * Why those three. `supersededAt` is the time the VISIBLE node was retired —
 * state of the node the actor is allowed to read, and it stops the actor
 * mistaking a retired node for a current one. `supersededReason` is free text
 * authored for the successor ("replaced by <label/id>") and cannot be reliably
 * sanitised, so it goes with the pointer. Unifying hidden with deleted means a
 * bound actor no longer sees a dangling id for a deleted successor either; a
 * dangling id was never actionable.
 *
 * Unbound actors (getCurrentActorScopes() === undefined: local mode, embedded,
 * daemon-internal callers) are never touched. Applied at the route / tool
 * layer, never inside stores.
 *
 * Cost: at most ONE batched lookup per response (ids already present among the
 * response's own — already-filtered — nodes need no lookup).
 */

import { getCurrentActorScopes } from './actorContext.js';
import { filterNodesByActorScope } from './scopeFilter.js';

export interface SuccessorPointerNode {
    id?: unknown;
    security_scopes?: string[];
    supersededBy?: string | null;
    supersededReason?: string | null;
}

/** Batched node lookup: id → node. Absent ids are simply missing from the map. */
export type NodesByIdsLookup = (ids: string[]) => Promise<Map<string, { id?: string; security_scopes?: string[] }>>;

/**
 * The set of ids, among `ids`, that exist AND are visible to the bound actor.
 * One lookup call. A lookup failure fails CLOSED (nothing is visible).
 */
async function visibleSuccessorIds(ids: string[], lookup: NodesByIdsLookup): Promise<Set<string>> {
    const out = new Set<string>();
    if (ids.length === 0) return out;
    let found: Map<string, { id?: string; security_scopes?: string[] }>;
    try {
        found = await lookup(ids);
    } catch {
        return out;
    }
    for (const id of ids) {
        const n = found.get(id);
        if (n && filterNodesByActorScope([{ security_scopes: n.security_scopes }]).length === 1) out.add(id);
    }
    return out;
}

/**
 * Return `nodes` with every `supersededBy` that names a node the bound actor
 * cannot see (hidden or absent) nulled out (see file header). The input array
 * and its elements are never mutated; unchanged nodes are returned by
 * reference. Unbound actor → `nodes` returned as-is, no lookup.
 *
 * `nodes` MUST already be actor-filtered: ids present in the array count as
 * visible without a lookup.
 */
export async function redactHiddenSuccessors<T extends object>(
    nodes: T[],
    lookup: NodesByIdsLookup,
): Promise<T[]> {
    if (getCurrentActorScopes() === undefined) return nodes;
    const present = new Set(nodes.map((n) => (n as SuccessorPointerNode).id as string));
    const needed = new Set<string>();
    for (const n of nodes) {
        const to = (n as SuccessorPointerNode).supersededBy;
        if (typeof to === 'string' && to.length > 0 && !present.has(to)) needed.add(to);
    }
    if (needed.size === 0) return nodes;
    const visible = await visibleSuccessorIds([...needed], lookup);
    let changed = false;
    const out = nodes.map((n) => {
        const to = (n as SuccessorPointerNode).supersededBy;
        if (typeof to !== 'string' || to.length === 0) return n;
        if (present.has(to) || visible.has(to)) return n;
        changed = true;
        return { ...n, supersededBy: null, supersededReason: null };
    });
    return changed ? out : nodes;
}

/** Single-node convenience over redactHiddenSuccessors (node must already be visible). */
export async function redactHiddenSuccessor<T extends object>(
    node: T,
    lookup: NodesByIdsLookup,
): Promise<T> {
    return (await redactHiddenSuccessors([node], lookup))[0]!;
}
