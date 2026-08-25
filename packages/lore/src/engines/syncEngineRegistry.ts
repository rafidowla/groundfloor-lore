/**
 * syncEngineRegistry.ts — Wave 4.3 per-workspace SyncEngine registry.
 *
 * Mirrors LocalGraphRegistry (engines/localGraphRegistry.ts): a lazy-opened
 * Map of (workspace name → SyncEngine). Before this, `routes/sync.ts` drove
 * ONE boot-bound SyncEngine constructed once in server.ts against the boot
 * workspace's graph + loreDir — so `POST /api/sync/push|pull|now` always
 * touched the boot workspace's WAL regardless of which workspace the calling
 * token was scoped to (routes/sync.ts gated with
 * `requireWriteToWorkspace(principal, undefined)`, the exact D-021(a)
 * anti-pattern: "always passes for any write-scoped token").
 *
 * After this: each workspace gets its own lazily-constructed SyncEngine,
 * rooted at THAT workspace's `.lore/` directory (its own WAL + cursor files),
 * built over the SAME LocalGraph the graph registry already opens for it. The
 * route layer resolves via `bindRouteTarget` (security/routeWorkspaceBinding.ts)
 * and passes the concrete target to `getOrOpen`, so a token scoped to ws-a can
 * only push/pull/now ws-a's WAL — ws-b's sync state is unreachable without a
 * cross-workspace-write scope.
 *
 * Chokepoint reuse: `getOrOpen` calls `graphRegistry.getGraphHandle(ws)` FIRST
 * to obtain the graph a new SyncEngine is built over. That resolves the
 * workspace's DECLARED engine, and delegates to the graph registry's own
 * `getOrOpen`, which runs the Wave 4.1 substrate guard
 * (`assertWorkspaceOpenAllowed`) — so a bound request that tries to open a
 * foreign workspace's SyncEngine throws `WorkspaceAccessDeniedError` before
 * this registry does any work of its own. Sync opens stay guarded "for free".
 *
 * Lifecycle:
 *   - `prime(bootWs, bootEngine)` seeds the cache with the daemon's existing
 *     boot-bound SyncEngine (pinned, never evicted/closed by this registry) so
 *     `getOrOpen(bootWs)` returns the SAME instance instead of constructing a
 *     second SyncEngine — and therefore a second WriteAheadLog — over the same
 *     `.lore/` directory. Only the boot engine auto-syncs
 *     (`startAutoSync`/`stopAutoSync`); lazily-opened siblings never do.
 *   - `invalidateUnpinned()` drops every lazily-built (unpinned) engine
 *     WITHOUT touching the pinned boot entry. Call this after an S9
 *     keychain-driven adapter upgrade (server.ts `setSyncEngine` hook) —
 *     SyncEngine takes its adapter BY VALUE at construction time, so a
 *     lazily-built engine constructed before the upgrade would keep pushing
 *     against the stale (pre-upgrade) adapter forever. The next `getOrOpen`
 *     for that workspace rebuilds against the current adapter via `getAdapter()`.
 *   - `disposeAll()` stops auto-sync on every cached engine (no-op for engines
 *     that never started it) and drops references. SyncEngine holds no native
 *     handles (its WAL is plain fs read/write, no open file descriptor kept
 *     across calls), so there is nothing to `await close()` — this is
 *     synchronous and safe to call from the shutdown drain / embedded dispose.
 *
 * No LRU cap (unlike LocalGraphRegistry's MAX_OPEN_WORKSPACES): a SyncEngine
 * is a thin wrapper (WAL path strings + cursor file paths + an in-memory
 * push-serialization chain), not a Kùzu mmap/connection-pool/LanceDB handle.
 * `evictOnInvalidate` still drops entries when workspaces.json moves a
 * workspace's on-disk path, mirroring the graph registry's cache-correctness
 * contract.
 */

import * as path from 'node:path';

import { SyncEngine } from './syncEngine.js';
import type { LocalGraphRegistry } from './localGraphRegistry.js';
import type { TsSdkAdapter } from './tsSdkAdapter.js';
import type { WorkspaceVerbatimResolver } from '../outbox/workspaceVerbatimResolver.js';
import type { OutboxStore } from '../outbox/types.js';
import { getWorkspacePath } from '../config/workspaces.js';
import { loreHome } from '../config/loreHome.js';

interface CacheEntry {
    engine: SyncEngine;
    /** Absolute workspace base path the engine's loreDir was derived from —
     *  used to detect workspaces.json edits that move a workspace's data on
     *  disk (same invalidation contract as LocalGraphRegistry). */
    path: string;
    /** Never evicted/closed/invalidated by this registry — the boot engine,
     *  owned by server.ts's `let syncEngine` and the outbox wiring. */
    pinned: boolean;
}

export interface SyncEngineRegistryDeps {
    /** Resolves (lazily opens) the per-workspace LocalGraph. Its own
     *  `getOrOpen` already runs the Wave 4.1 substrate guard, so calling it
     *  FIRST covers sync opens under the same chokepoint. */
    graphRegistry: LocalGraphRegistry;
    /** Resolves (lazily opens) the per-workspace verbatim (LanceDB) store so
     *  pulled nodes mirror into the requesting workspace's vector store
     *  instead of the boot workspace's. */
    workspaceVerbatimResolver: WorkspaceVerbatimResolver;
    /** Read fresh — the adapter is `let`-mutable in server.ts and may be
     *  upgraded post-boot (S9 keychain preference). */
    getAdapter: () => TsSdkAdapter | null;
    /** Durable outbox store — SyncEngine mirrors pulled nodes through it
     *  exactly like the boot engine does. */
    outboxStore: OutboxStore | null;
    deploymentMode: 'local' | 'cloud' | 'embedded';
    /** TW-2a — instance-scoped Lore data root, mirroring LocalGraphRegistry's
     *  `home` option so an embedded host with a distinct `dataDir` resolves
     *  disjoint per-workspace loreDirs instead of colliding on the
     *  process-global LORE_HOME. */
    home?: string;
}

export class SyncEngineRegistry {
    private cache = new Map<string, CacheEntry>();
    private inflight = new Map<string, Promise<SyncEngine>>();
    private readonly home: string;

    constructor(private readonly deps: SyncEngineRegistryDeps) {
        this.home = deps.home ?? loreHome();
    }

    /**
     * Pre-seed the cache with the daemon's existing boot-bound SyncEngine.
     * Pinned — never evicted, invalidated, or auto-sync-stopped by this
     * registry; the boot engine's lifecycle (including `startAutoSync`) stays
     * owned by server.ts exactly as before this wave.
     */
    prime(workspace: string, engine: SyncEngine): void {
        let resolvedPath: string;
        try {
            resolvedPath = getWorkspacePath(workspace, this.home);
        } catch {
            return; // Unregistered name — a later getOrOpen throws the same error.
        }
        this.cache.set(workspace, { engine, path: resolvedPath, pinned: true });
    }

    /**
     * Lazy-open the SyncEngine for `workspace`. Delegates to
     * `graphRegistry.getGraphHandle(workspace)` FIRST so the Wave 4.1 substrate
     * guard (`assertWorkspaceOpenAllowed`, reached via the graph registry's own
     * getOrOpen) covers this open too — a bound
     * request confined to ws-a that calls `getOrOpen('ws-b')` throws
     * `WorkspaceAccessDeniedError` before a second SyncEngine is ever
     * constructed.
     *
     * Repeated calls for the same workspace return the same instance unless
     * workspaces.json was edited to move that workspace to a different path,
     * in which case the stale entry is dropped and a fresh engine is built.
     */
    async getOrOpen(workspace: string): Promise<SyncEngine> {
        // getGraphHandle, not getOrOpen: SyncEngine WRITES pulled nodes into
        // this graph, so on a Surreal-backed workspace the Kùzu accessor sent
        // every synced node to the database nothing reads. It still delegates
        // to getOrOpen internally, so the Wave 4.1 confinement guard described
        // above continues to cover this open.
        const graph = await this.deps.graphRegistry.getGraphHandle(workspace);

        let resolvedPath: string;
        try {
            resolvedPath = getWorkspacePath(workspace, this.home);
        } catch {
            resolvedPath = workspace; // Unreachable in practice: getOrOpen above already
            // threw workspace_not_found for an unregistered name.
        }

        const cached = this.cache.get(workspace);
        if (cached && cached.path === resolvedPath) return cached.engine;
        if (cached && cached.path !== resolvedPath && !cached.pinned) {
            cached.engine.stopAutoSync();
            this.cache.delete(workspace);
        }

        const inflight = this.inflight.get(workspace);
        if (inflight) return inflight;

        const opening = (async (): Promise<SyncEngine> => {
            const fresh = this.cache.get(workspace);
            if (fresh && fresh.path === resolvedPath) return fresh.engine;

            const perWsLoreDir = path.join(getWorkspacePath(workspace, this.home), '.lore');
            const verbatim = await this.deps.workspaceVerbatimResolver.getOrOpen(workspace);
            const engine = new SyncEngine(
                graph,
                perWsLoreDir,
                this.deps.deploymentMode === 'cloud' ? null : this.deps.getAdapter(),
                verbatim,
                this.deps.outboxStore,
            );
            // Never call startAutoSync on a lazily-opened engine — only the
            // boot engine auto-syncs (unchanged daemon behavior).
            this.cache.set(workspace, { engine, path: resolvedPath, pinned: false });
            return engine;
        })();
        this.inflight.set(workspace, opening);
        try {
            return await opening;
        } finally {
            this.inflight.delete(workspace);
        }
    }

    /**
     * Drop every lazily-built (unpinned) engine, leaving the pinned boot
     * entry untouched. Call after an S9 keychain adapter upgrade so stale
     * (pre-upgrade) sibling engines are rebuilt against the new adapter on
     * next access instead of silently pushing through the old credential
     * forever (SyncEngine takes its adapter by value at construction time).
     */
    invalidateUnpinned(): void {
        for (const [name, entry] of [...this.cache.entries()]) {
            if (entry.pinned) continue;
            entry.engine.stopAutoSync();
            this.cache.delete(name);
        }
    }

    /** Snapshot of currently-cached workspace names. For tests/diagnostics. */
    openedNames(): string[] {
        return [...this.cache.keys()];
    }

    /**
     * Stop auto-sync on every cached engine (no-op for engines that never
     * started it — only the boot engine does) and drop all references,
     * including the pinned boot entry. SyncEngine holds no native handles, so
     * this is synchronous; safe to call from the shutdown drain / embedded
     * dispose right alongside `LocalGraphRegistry.disposeAll()`.
     */
    disposeAll(): void {
        for (const entry of this.cache.values()) {
            try { entry.engine.stopAutoSync(); } catch { /* best-effort */ }
        }
        this.cache.clear();
        this.inflight.clear();
    }
}
