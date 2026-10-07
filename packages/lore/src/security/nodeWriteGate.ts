/**
 * nodeWriteGate.ts — single-node WRITE gate (REST routes + MCP tools) on top of
 * the shared writeTargetGate.ts helpers. It exists so that every single-node
 * write path (create/upsert, supersede/unsupersede, delete, mark-stale) asks
 * the SAME question the same way instead of re-deriving the verbatim handle and
 * the unbound short-circuit per call site.
 *
 * Contract (see writeTargetGate.ts for the semantics of each helper):
 *  - UNBOUND caller (`getCurrentActorScopes() === undefined`): every function
 *    here returns the permissive answer BEFORE touching any handle. Zero
 *    lookups, zero opens — behaviour identical to before the gate existed.
 *  - BOUND actor + existing item: `nodeMutateVisible` false => the caller must
 *    answer with its ordinary not-found response and no side effect.
 *  - BOUND actor + caller-chosen create id: `nodeCreateIdBlocked` true => the
 *    caller refuses with ID_UNAVAILABLE. An unopenable verbatim store FAILS
 *    CLOSED here (a canonical row we cannot read might be the hidden one).
 *  - `supersedesVisibilityFor` returns a callback (bound only) the supersession
 *    policy uses so a hidden `supersedes` id / near-duplicate hit is treated
 *    exactly like a nonexistent one.
 */

import type { StorageBundle } from '../mcp/services.js';
import type { LocalGraphRegistry } from '../engines/localGraphRegistry.js';
import { getCurrentActorScopes } from './actorContext.js';
import type { ItemScopeDeps } from './itemScopes.js';
import {
    buildWriteScopeDeps,
    createIdBlockedForCurrentActor,
    mutateTargetVisible,
    type WriteScopeHandles,
} from './writeTargetGate.js';

export interface NodeWriteGateHandles {
    /** Workspace the write targets (version-store key; '' = boot graph). */
    workspace: string;
    store: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    versionStore?: WriteScopeHandles['versionStore'];
    /** Per-workspace verbatim resolver; falls back to `store.loreVerbatim` when absent. */
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<unknown> };
}

type VerbatimLike = NonNullable<WriteScopeHandles['verbatim']>;

/** Resolve the workspace's verbatim store. Only called for a bound actor. */
async function resolveVerbatim(h: NodeWriteGateHandles): Promise<VerbatimLike | undefined> {
    if (h.workspaceVerbatimResolver && h.workspace !== '') {
        return (await h.workspaceVerbatimResolver.getOrOpen(h.workspace)) as VerbatimLike;
    }
    return (h.store as { loreVerbatim?: unknown }).loreVerbatim as VerbatimLike | undefined;
}

/** May the current actor operate on this EXISTING node? Unbound => true, no lookups. */
export async function nodeMutateVisible(nodeId: string, h: NodeWriteGateHandles): Promise<boolean> {
    if (getCurrentActorScopes() === undefined) return true;
    let verbatim: VerbatimLike | undefined;
    // An unopenable verbatim store only removes the LAST-resort source; the live
    // node / version row still decide. A truly unreadable item resolves unknown => hidden.
    try { verbatim = await resolveVerbatim(h); } catch { verbatim = undefined; }
    const deps = buildWriteScopeDeps({ workspace: h.workspace, store: h.store, graphRegistry: h.graphRegistry, versionStore: h.versionStore, verbatim });
    return mutateTargetVisible({ nodeId, verbatimId: `lore:${nodeId}` }, deps);
}

/** Must the current actor be refused this caller-chosen create id? Unbound => false, no lookups. */
export async function nodeCreateIdBlocked(nodeId: string, h: NodeWriteGateHandles): Promise<boolean> {
    if (getCurrentActorScopes() === undefined) return false;
    let verbatim: VerbatimLike | undefined;
    try { verbatim = await resolveVerbatim(h); } catch { return true; } // fail closed
    const deps = buildWriteScopeDeps({ workspace: h.workspace, store: h.store, graphRegistry: h.graphRegistry, versionStore: h.versionStore, verbatim });
    return createIdBlockedForCurrentActor({ nodeId, verbatimId: `lore:${nodeId}` }, deps);
}

/** Visibility callback for the supersession policy; undefined for an unbound caller. */
export function supersedesVisibilityFor(h: NodeWriteGateHandles): ((id: string) => Promise<boolean>) | undefined {
    if (getCurrentActorScopes() === undefined) return undefined;
    return (id: string) => nodeMutateVisible(id, h);
}

/**
 * Same callback for the bulk routes (bulk upsert, import), which already hold an
 * ItemScopeDeps for the workspace they write to. undefined for an unbound caller.
 */
export function supersedesVisibilityFromDeps(sd: ItemScopeDeps): ((id: string) => Promise<boolean>) | undefined {
    if (getCurrentActorScopes() === undefined) return undefined;
    return (id: string) => mutateTargetVisible({ nodeId: id, verbatimId: `lore:${id}` }, sd);
}

/** Keep only the ids the current actor may operate on (mark-stale): hidden ids are dropped like missing ones. */
export async function filterMutableNodeIds(ids: string[], h: NodeWriteGateHandles): Promise<string[]> {
    if (getCurrentActorScopes() === undefined) return ids;
    const out: string[] = [];
    for (const id of ids) if (await nodeMutateVisible(id, h)) out.push(id);
    return out;
}

/**
 * Supersede target gate. Returns the engine's own refusal object when a side is
 * hidden from the bound actor, else null (proceed to the engine). Engine order
 * is self -> old-not-found -> new-not-found; this reproduces it exactly:
 *  - oldId === newId  -> null (the engine's `self` check runs before any lookup,
 *    so hidden and missing already answer alike).
 *  - old hidden       -> old-not-found (a missing old answers the same).
 *  - old visible but new hidden -> new-not-found, UNLESS old does not actually
 *    exist live (a deleted node can still be "visible" via its version log), in
 *    which case the engine would have said old-not-found first.
 * Unbound => null with no lookups.
 */
export async function supersedeHiddenFailure(
    oldId: string,
    newId: string,
    h: NodeWriteGateHandles,
    getLiveNode: (id: string) => Promise<unknown>,
): Promise<{ ok: false; reason: 'old-not-found' | 'new-not-found' } | null> {
    if (getCurrentActorScopes() === undefined) return null;
    if (oldId === newId) return null;
    if (!(await nodeMutateVisible(oldId, h))) return { ok: false, reason: 'old-not-found' };
    if (await nodeMutateVisible(newId, h)) return null;
    return (await getLiveNode(oldId)) ? { ok: false, reason: 'new-not-found' } : { ok: false, reason: 'old-not-found' };
}
