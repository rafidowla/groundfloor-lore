/**
 * workspaceVerbatimResolver.ts — SP-F3.
 *
 * Per-workspace VerbatimStore resolver for the outbox replicator.
 *
 * Background: the LocalGraphRegistry already resolves a per-workspace
 * `LocalGraph` (Kùzu) by name, but it deliberately leaves the verbatim
 * (LanceDB) store global — see localGraphRegistry.ts:20-21 "Verbatim store
 * remains global (id-keyed); per-workspace verbatim is a separate concern."
 * That gap is exactly what let the replicator replay `verbatim.upsert` rows
 * into the BOOT workspace's LanceDB regardless of `entry.workspace`.
 *
 * This resolver closes that gap: given a workspace name it resolves the
 * workspace's base path (the same `entry.path` the graph registry uses) and
 * lazily constructs + initializes a `VerbatimStore` rooted at that path's
 * `.lore/lancedb`. Instances are cached by resolved path so two names that
 * alias the same on-disk path (the L5b path-dedup case) share one store, and
 * so repeated replays don't re-open LanceDB every row.
 *
 * Scope kept minimal on purpose:
 *   - No LRU eviction here (the replicator touches a small, stable set of
 *     workspaces per tick; the graph registry's MAX_OPEN cap already bounds
 *     the Kùzu side). `closeAll()` releases handles on shutdown.
 *   - The BOOT workspace's VerbatimStore is primed in so the replicator
 *     reuses the daemon's existing instance instead of opening a second
 *     LanceDB handle on the same dir.
 */

import { VerbatimStore } from '../engines/verbatimStore.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { assertWorkspaceOpenAllowed } from '../security/routeWorkspaceBinding.js';
import { getWorkspacePath } from '../config/workspaces.js';

export class WorkspaceVerbatimResolver {
    /** path → store (shared across aliasing names). */
    private byPath = new Map<string, VerbatimStore>();
    /** In-flight initialize promises so concurrent first-time opens for
     *  the same path don't construct two stores racing on the same dir. */
    private inflight = new Map<string, Promise<VerbatimStore>>();
    /** Primed (boot-owned) paths the resolver must NOT close — the daemon
     *  shutdown drain owns those handles. */
    private pinnedPaths = new Set<string>();

    constructor(private readonly embeddingProvider?: EmbeddingProvider) {}

    /**
     * Pre-seed the boot-bound VerbatimStore for a workspace so
     * getOrOpen(boot) returns the same instance instead of opening a
     * second LanceDB handle on the same dir. No-op if the workspace name
     * is not registered (a later getOrOpen throws the same error).
     */
    prime(workspace: string, store: VerbatimStore): void {
        let resolvedPath: string;
        try {
            resolvedPath = getWorkspacePath(workspace);
        } catch {
            return;
        }
        this.byPath.set(resolvedPath, store);
        this.pinnedPaths.add(resolvedPath);
    }

    /**
     * Resolve (lazily open) the VerbatimStore for `workspace`. Throws the
     * same `workspace_not_found` error shape getWorkspacePath throws when
     * the name is unknown — the replicator catches it and records a row
     * failure (retryable) so a transiently-missing workspace entry does
     * not silently drop the write.
     */
    async getOrOpen(workspace: string): Promise<VerbatimStore> {
        // Wave 4.1 — substrate chokepoint (same contract as
        // LocalGraphRegistry.getOrOpen). The outbox replicator calls this from
        // its own timer chain (no request slot) → allowed, unchanged.
        assertWorkspaceOpenAllowed(workspace);
        const resolvedPath = getWorkspacePath(workspace);
        const cached = this.byPath.get(resolvedPath);
        if (cached) return cached;
        const inflight = this.inflight.get(resolvedPath);
        if (inflight) return inflight;
        const opening = (async () => {
            const store = new VerbatimStore(resolvedPath, this.embeddingProvider);
            await store.initialize();
            this.byPath.set(resolvedPath, store);
            return store;
        })();
        this.inflight.set(resolvedPath, opening);
        try {
            return await opening;
        } finally {
            this.inflight.delete(resolvedPath);
        }
    }

    /** Test/observability hook — number of distinct open stores. */
    openCount(): number {
        return this.byPath.size;
    }

    /**
     * Close + drop every lazily-opened store. Pinned (boot-owned) paths
     * are dropped from the map but NOT closed — the daemon shutdown drain
     * closes the boot VerbatimStore. Best-effort per store.
     */
    async closeAll(): Promise<void> {
        for (const [p, store] of this.byPath.entries()) {
            if (this.pinnedPaths.has(p)) continue;
            const closable = store as unknown as { close?: () => Promise<void> | void };
            if (typeof closable.close === 'function') {
                try { await closable.close(); } catch { /* best-effort */ }
            }
        }
        this.byPath.clear();
        this.inflight.clear();
    }
}
