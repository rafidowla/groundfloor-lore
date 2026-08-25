/**
 * querySeedStore.ts — resolve the verbatim (vector) store a NON-retrieve()
 * read surface should seed from.
 *
 * `recall`, `GET /api/recall`, `GET /api/search` and the MCP `search` tool all
 * go through `retrieve()`, which resolves this itself (`resolveSeedStore`).
 * Two surfaces do NOT go through retrieve() and hand-roll their own seed step:
 * `POST /api/query` and the MCP `structured_query` tool. They had two copies of
 * the decision and they drifted — `/api/query` was fixed to resolve
 * per-workspace while `structured_query` kept seeding from
 * `deps.store.storageClient`, the BOOT handle, which
 * `recall/retrieve.ts:243-248` names as "the exact confinement bug".
 *
 * This module is that decision, once, so the two cannot drift again.
 *
 * Selection (identical to `retrieve.ts::resolveSeedStore`):
 *   - Reading the boot/active graph → the boot storageClient. Its verbatim
 *     handle already points at exactly this workspace's LanceDB, so this is
 *     the unchanged pre-P2 path.
 *   - Reading a non-active workspace WITH a resolver → `getOrOpen(workspace)`.
 *   - No resolver, or the open fails (never-embedded workspace, missing or
 *     corrupt LanceDB, a chokepoint denial) → NULL, and the caller SKIPS the
 *     vector seed and falls through to the target workspace's OWN keyword
 *     scan. It must NEVER fall back to the boot/active store: seeding wsB from
 *     wsA's LanceDB surfaces foreign ids, count-gates the semantic phase on
 *     the wrong workspace, and on an id collision ranks B's node by A's vector
 *     similarity.
 *
 * License: original work for groundfloor-lore.
 */

/** Minimal verbatim (vector) surface a hand-rolled seed step uses. */
export interface QuerySeedStore {
    count(): Promise<number>;
    search(query: string, limit: number): Promise<Array<{ id: string; score?: number }>>;
}

/** The subset of any read surface's deps this decision needs. Structural, so
 *  both `SearchDeps` (HTTP) and `SearchToolsDeps` (MCP) satisfy it as-is. */
export interface QuerySeedStoreDeps {
    store: {
        loreGraph: unknown;
        storageClient: {
            verbatimCount(): Promise<number>;
            verbatimSearch(query: string, limit: number, filter?: { ecosystem?: string }): Promise<Array<{ id: string; score?: number }>>;
        };
    };
    workspaceVerbatimResolver?: {
        getOrOpen(ws: string): Promise<QuerySeedStore>;
    };
}

export async function resolveQuerySeedStore(
    deps: QuerySeedStoreDeps,
    queryGraph: unknown,
    workspace: string,
): Promise<QuerySeedStore | null> {
    if (queryGraph === deps.store.loreGraph) {
        return {
            count: () => deps.store.storageClient.verbatimCount(),
            search: (q, n) => deps.store.storageClient.verbatimSearch(q, n),
        };
    }
    if (!deps.workspaceVerbatimResolver) return null;
    try {
        return await deps.workspaceVerbatimResolver.getOrOpen(workspace);
    } catch {
        return null;
    }
}
