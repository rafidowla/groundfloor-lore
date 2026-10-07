/**
 * writeTargetBatch.ts — batched forms of the write-target gate for the bulk
 * routes (POST /api/nodes/bulk, /api/nodes/bulk-delete, /api/edges/bulk,
 * POST /api/import, MCP import_data). One lookup per DISTINCT id, a bounded
 * number in flight (same CONCURRENCY as filterVersionsByActorScope in
 * mcp/tools/versionScopeGate.ts), and no lookups at all for an unbound caller.
 *
 * Visibility is still decided ONLY by security/writeTargetGate.ts; this module
 * just fans the per-id gates out.
 */

import { getCurrentActorScopes } from './actorContext.js';
import type { ItemScopeDeps } from './itemScopes.js';
import { createIdBlockedForCurrentActor, mutateTargetVisible } from './writeTargetGate.js';

const CONCURRENCY = 16;

async function mapDistinct(ids: Iterable<string>, fn: (id: string) => Promise<boolean>): Promise<Map<string, boolean>> {
    const distinct = [...new Set(ids)];
    const out = new Map<string, boolean>();
    for (let i = 0; i < distinct.length; i += CONCURRENCY) {
        await Promise.all(distinct.slice(i, i + CONCURRENCY).map(async (id) => { out.set(id, await fn(id)); }));
    }
    return out;
}

/** Subset of `ids` the current actor must be refused as caller-chosen create ids. Unbound → empty, no lookups. */
export async function blockedCreateIdsForCurrentActor(ids: Iterable<string>, deps: ItemScopeDeps): Promise<Set<string>> {
    if (getCurrentActorScopes() === undefined) return new Set();
    const m = await mapDistinct(ids, (id) => createIdBlockedForCurrentActor({ nodeId: id }, deps));
    return new Set([...m].filter(([, blocked]) => blocked).map(([id]) => id));
}

/**
 * Subset of node `ids` the current actor may operate on (exists AND visible).
 * Unbound → null (meaning "all", no lookups). A missing id is not in the set,
 * exactly like a hidden one.
 */
export async function visibleMutateIdsForCurrentActor(ids: Iterable<string>, deps: ItemScopeDeps): Promise<Set<string> | null> {
    if (getCurrentActorScopes() === undefined) return null;
    const m = await mapDistinct(ids, (id) => mutateTargetVisible({ nodeId: id, verbatimId: `lore:${id}` }, deps));
    return new Set([...m].filter(([, ok]) => ok).map(([id]) => id));
}

/**
 * Verbatim row ids (canonical and `#rev` history) of a listing the current actor may see.
 * A history row is decided by its CANONICAL item (`canonicalOf`), so hidden history is
 * excluded exactly like the hidden row it belongs to. One lookup per DISTINCT canonical
 * item, CONCURRENCY in flight. Unbound → null (meaning "all", no lookups).
 */
export async function visibleVerbatimRowIdsForCurrentActor(
    ids: string[],
    deps: ItemScopeDeps,
    canonicalOf: (id: string) => { nodeId: string; verbatimId: string },
): Promise<Set<string> | null> {
    if (getCurrentActorScopes() === undefined) return null;
    const byCanon = new Map<string, { nodeId: string; verbatimId: string }>();
    for (const id of ids) { const c = canonicalOf(id); byCanon.set(c.verbatimId, c); }
    const m = await mapDistinct(byCanon.keys(), (vid) => mutateTargetVisible(byCanon.get(vid)!, deps));
    return new Set(ids.filter((id) => m.get(canonicalOf(id).verbatimId) === true));
}
