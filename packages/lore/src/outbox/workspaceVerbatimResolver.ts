/**
 * workspaceVerbatimResolver.ts — SP-F3, extended STEP2-CLOSE-PATH-DESIGN.md (c).
 *
 * Per-workspace VerbatimStore resolver for the outbox replicator.
 *
 * Background: the LocalGraphRegistry already resolves a per-workspace
 * graph handle by name, but it deliberately leaves the verbatim
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
 * (c) Idle eviction — mirrors `LocalGraphRegistry`'s idle-LRU shape (see
 * localGraphRegistry.ts), NOT invented fresh. `openCount()` predates this;
 * `evictIdle`/`closeWorkspace`/the sweep timer are new. Unlike the graph
 * registry, this does NOT feed the daemon's idle sweep — see the SCOPE
 * CHANGE note below.
 *
 * SCOPE CHANGE (measured, see docs/PERFORMANCE-MEMORY.md §9): SurrealDB's
 * native addon never frees a datastore on close(), so graph evict+reopen
 * LEAKS ~100MB per reopen — evicting the graph half is net-negative on that
 * driver. The verbatim (LanceDB) half DOES free memory on close() (the (a)
 * fix), so evicting IT is net-positive. The two eviction sweeps are
 * therefore INDEPENDENT: this resolver runs its own timer, gated exactly
 * like the registry's (`autoEvict`: true for the daemon, false embedded —
 * see server.ts's construction site), and never triggers or is triggered by
 * `LocalGraphRegistry`'s sweep.
 */

import { VerbatimStore } from '../engines/verbatimStore.js';
import type { VerbatimStoreApi } from '../engines/verbatimStoreApi.js';
import { VerbatimSearchWorkerProxy, resolveSearchWorkerIsolation, type SearchWorkerPolicy } from '../engines/verbatimSearchWorkerProxy.js';
import { openWorkspaceVerbatim, resolveVerbatimEngineForPath } from '../engines/openWorkspaceVerbatim.js';
import type { VerbatimStoreRole } from '../engines/verbatimStoreRole.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { assertWorkspaceOpenAllowed } from '../security/routeWorkspaceBinding.js';
import { getWorkspacePath } from '../config/workspaces.js';
import { log } from '../logger.js';
import { loreHome } from '../config/loreHome.js';

function parseResolverEnvMs(raw: string | undefined, fallback: number): number {
    if (!raw || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `lastAccessedAt` given to a store OPENED by background/maintenance access
 *  (`{ touch: false }`) with no prior cache entry — mirrors
 *  LocalGraphRegistry's `STALE_SENTINEL_MS`: epoch 0 guarantees the entry is
 *  eligible for eviction at the very next sweep tick, so a maintenance
 *  fan-out can't grant an idle workspace a fresh full-TTL lease just by
 *  opening it to check its policy. */
const STALE_SENTINEL_MS = 0;

/** hc-verbatim-resolver-idle-sweep — env override LORE_VERBATIM_IDLE_TTL_MS
 *  (default 30 min, matching LORE_REGISTRY_IDLE_TTL_MS's default so the
 *  graph and vector halves of a workspace go idle together). */
const IDLE_TTL_MS = parseResolverEnvMs(process.env.LORE_VERBATIM_IDLE_TTL_MS, 30 * 60 * 1000);
/** hc-verbatim-resolver-idle-sweep — env override LORE_VERBATIM_SWEEP_MS
 *  (default 10 min, matching LORE_REGISTRY_SWEEP_MS's default). */
const SWEEP_INTERVAL_MS = parseResolverEnvMs(process.env.LORE_VERBATIM_SWEEP_MS, 10 * 60 * 1000);

interface CacheEntry {
    store: VerbatimStoreApi;
    lastAccessedAt: number;
    /** Every workspace NAME ever resolved to this path — the map itself is
     *  keyed by PATH (aliasing), but the eviction guardrail needs to ask
     *  "does workspace X have pending work", which is name-keyed. */
    names: Set<string>;
}

/**
 * Guardrail collaborators `evictIdle`/`closeWorkspace` ask before releasing
 * a handle — see their docstrings and the design's "Database guardrails"
 * section (eviction releases handles, never queued data). Both optional and
 * fail-OPEN (treated as "no pending work") when omitted or when the
 * underlying store doesn't implement the optional query — matching how
 * `OutboxStore.listPendingForWorkspace` is itself optional on the
 * interface. Wired late via `setGuardrails()` (server.ts constructs the
 * embed queue and outbox wiring AFTER this resolver).
 */
export interface WorkspaceVerbatimResolverGuardrails {
    /** Any pending or in-flight embed-queue work for this workspace? */
    hasPendingEmbeds?: (workspace: string) => boolean;
    /** Any pending/failed outbox row queued for this workspace? */
    hasPendingOutbox?: (workspace: string) => Promise<boolean>;
}

export class WorkspaceVerbatimResolver {
    /** path → entry (shared across aliasing names). */
    private byPath = new Map<string, CacheEntry>();
    /** In-flight initialize promises so concurrent first-time opens for
     *  the same path don't construct two stores racing on the same dir. */
    private inflight = new Map<string, Promise<VerbatimStoreApi>>();
    /** Primed (boot-owned) paths the resolver must NOT close — the daemon
     *  shutdown drain owns those handles. */
    private pinnedPaths = new Set<string>();
    /** Clock seam so evictIdle/the sweep are unit-testable without real
     *  wall time — mirrors LocalGraphRegistry's `now`. */
    private readonly now: () => number;
    /** Background idle-eviction timer (when constructed with autoEvict). */
    private sweepTimer: NodeJS.Timeout | null = null;
    private guardrails: WorkspaceVerbatimResolverGuardrails = {};
    /** TW-2a-class fix (STEP2-CLOSE-PATH-DESIGN.md (e)) — instance-scoped Lore
     *  data root, threaded into every getWorkspacePath() call the same way
     *  LocalGraphRegistry threads its own `home`. Without this, a host that
     *  calls `createLore({ dataDir })` with `dataDir !== process.env.LORE_HOME`
     *  had its graph half resolve workspaces under `dataDir` (via the
     *  registry's own `home`) while this resolver silently fell back to
     *  `loreHome()` (the process-global `LORE_HOME`) — the two halves of ONE
     *  workspace could resolve to two DIFFERENT homes. Defaults to `loreHome()`,
     *  preserving daemon behaviour exactly (the daemon never passes `dataDir`).
     */
    private readonly home: string;

    /**
     * LORE-ASK-VECTOR-STORE-ROLE.md — optional per-path role resolution. A
     * plain value applies to every path this resolver opens; a function is
     * called with the resolved on-disk path so different workspaces can get
     * different roles. Omitted (undefined) is byte-identical to before this
     * option existed: every lazily-opened VerbatimStore defaults to
     * role:'both'. NOTE: this only affects the direct VerbatimStore
     * construction branch in getOrOpen() — when searchWorkerIsolation is on,
     * the store opens in a child process (VerbatimSearchWorkerProxy never
     * opens LanceDB in-process itself), so role has no effect there.
     */
    private readonly vectorStoreRole?: VerbatimStoreRole | ((basePath: string) => VerbatimStoreRole);
    /** True when `embeddingProvider` is a host-injected provider
     *  (CreateLoreOptions.embeddingProvider) — threaded into VerbatimStore
     *  (and the search-worker proxy) as strictFingerprintCheck. See
     *  verbatimFingerprintGate.ts for the design decision. */
    private readonly strictFingerprintCheck?: boolean;

    constructor(
        private readonly embeddingProvider?: EmbeddingProvider,
        /**
         * Either a fixed boolean (today's behaviour — applies to every store
         * this resolver opens) or a per-path policy function consulted once,
         * at first open, with that store's resolved path — LORE-ASK-SEARCH-
         * WORKER-POLICY. `undefined` here means "no decision made by this
         * resolver's constructor" — callers (server.ts) are expected to
         * already have applied their own env fallback (`searchWorkerIsolationEnabled()`)
         * before passing a value in, so `undefined` behaves the same as
         * `false` (in-process), matching pre-policy behaviour when nothing
         * is configured anywhere.
         */
        private readonly searchWorkerIsolation?: boolean | SearchWorkerPolicy,
        private readonly embedOverrides?: Record<string, unknown>,
        opts: {
            now?: () => number;
            autoEvict?: boolean;
            home?: string;
            vectorStoreRole?: VerbatimStoreRole | ((basePath: string) => VerbatimStoreRole);
            /** True when `embeddingProvider` is a host-injected provider
             *  (CreateLoreOptions.embeddingProvider) — threaded into VerbatimStore
             *  (and the search-worker proxy) as strictFingerprintCheck. See
             *  verbatimFingerprintGate.ts for the design decision. */
            strictFingerprintCheck?: boolean;
        } = {},
    ) {
        this.now = opts.now ?? Date.now;
        this.home = opts.home ?? loreHome();
        this.vectorStoreRole = opts.vectorStoreRole;
        this.strictFingerprintCheck = opts.strictFingerprintCheck;
        if (opts.autoEvict) this.startEvictionSweep();
    }

    /** Late-bound because server.ts constructs the embed queue and outbox
     *  wiring after this resolver. Safe to call any time; entries evicted
     *  before this runs simply skip the guardrail check (fail-open). */
    setGuardrails(guardrails: WorkspaceVerbatimResolverGuardrails): void {
        this.guardrails = guardrails;
    }

    /** SP-11-style — start the periodic idle-workspace eviction sweep.
     *  Idempotent; the timer is unref()'d so it never holds the process
     *  open. Mirrors LocalGraphRegistry.startEvictionSweep(). */
    startEvictionSweep(): void {
        if (this.sweepTimer) return;
        const t = setInterval(() => { void this.evictIdle(this.now(), IDLE_TTL_MS); }, SWEEP_INTERVAL_MS);
        if (typeof t.unref === 'function') t.unref();
        this.sweepTimer = t;
    }

    /** Stop the periodic eviction sweep (graceful shutdown). */
    stopEvictionSweep(): void {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }

    /**
     * Pre-seed the boot-bound VerbatimStore for a workspace so
     * getOrOpen(boot) returns the same instance instead of opening a
     * second LanceDB handle on the same dir. No-op if the workspace name
     * is not registered (a later getOrOpen throws the same error).
     */
    prime(workspace: string, store: VerbatimStoreApi): void {
        let resolvedPath: string;
        try {
            resolvedPath = getWorkspacePath(workspace, this.home);
        } catch {
            return;
        }
        this.byPath.set(resolvedPath, { store, lastAccessedAt: this.now(), names: new Set([workspace]) });
        this.pinnedPaths.add(resolvedPath);
    }

    /**
     * Resolve (lazily open) the VerbatimStore for `workspace`. Throws the
     * same `workspace_not_found` error shape getWorkspacePath throws when
     * the name is unknown — the replicator catches it and records a row
     * failure (retryable) so a transiently-missing workspace entry does
     * not silently drop the write.
     *
     * `opts.touch` (default true) — pass `{ touch: false }` for BACKGROUND/
     * MAINTENANCE access (the daemon's periodic retention/consistency
     * fan-outs), which must NOT count as user activity: a cache-hit then
     * returns the store WITHOUT bumping `lastAccessedAt`. Mirrors
     * `LocalGraphRegistry.getGraphHandle`'s same option — see
     * docs/PERFORMANCE-MEMORY.md §11.
     */
    async getOrOpen(workspace: string, opts: { touch?: boolean } = {}): Promise<VerbatimStoreApi> {
        // Wave 4.1 — substrate chokepoint (same contract as
        // LocalGraphRegistry.getOrOpen). The outbox replicator calls this from
        // its own timer chain (no request slot) → allowed, unchanged.
        assertWorkspaceOpenAllowed(workspace);
        const touch = opts.touch !== false;
        const resolvedPath = getWorkspacePath(workspace, this.home);
        const cached = this.byPath.get(resolvedPath);
        if (cached) {
            if (touch) cached.lastAccessedAt = this.now(); // (c) — touch for idle LRU (user access only).
            cached.names.add(workspace);
            return cached.store;
        }
        const inflight = this.inflight.get(resolvedPath);
        if (inflight) return inflight;
        const opening = (async () => {
            const role = typeof this.vectorStoreRole === 'function' ? this.vectorStoreRole(resolvedPath) : this.vectorStoreRole;
            // 3.21 step 2 part 2 — which engine THIS workspace declares.
            const vectorEngine = resolveVerbatimEngineForPath(resolvedPath, { workspaceId: workspace, home: this.home }).engine;
            // LORE-ASK-SEARCH-WORKER-POLICY: resolve this store's isolation
            // decision once, at first open. A function is the per-path policy
            // (called with the resolved path — its answer is authoritative);
            // a boolean/undefined is today's fixed, resolver-wide value.
            // resolveSearchWorkerIsolation owns the recursion guard (inside a
            // worker ⇒ always false) and the throwing-policy fallback (warn
            // once, then the env gate). `undefined` is mapped to `false` HERE,
            // not left to the helper (which would read the env gate): the
            // resolver's pre-policy contract was "undefined ⇒ in-process", and
            // server.ts already passes the env-resolved value when no policy.
            // `vectorEngine` is threaded through too — a 'sqlite' workspace
            // never spawns a search worker regardless of policy/env.
            const useWorker = resolveSearchWorkerIsolation(resolvedPath, this.searchWorkerIsolation ?? false, vectorEngine);
            const store = useWorker
                ? new VerbatimSearchWorkerProxy(resolvedPath, this.embedOverrides, this.embeddingProvider, this.strictFingerprintCheck ?? false) as unknown as VerbatimStoreApi
                : openWorkspaceVerbatim(resolvedPath, this.embeddingProvider, {
                    workspaceId: workspace,
                    home: this.home,
                    role,
                    strictFingerprintCheck: this.strictFingerprintCheck ?? false,
                    // The live swap on a committed background promotion —
                    // see swapToLance() below.
                    onLancePromoted: () => this.swapToLance(workspace),
                });
            await store.initialize();
            // Background open (touch:false): stale sentinel, not `this.now()`
            // — mirrors LocalGraphRegistry's matching fix. A maintenance
            // fan-out reopening an evicted/never-opened workspace must not
            // hand it a fresh full-TTL lease; it stays eligible for the very
            // next eviction sweep tick (docs/PERFORMANCE-MEMORY.md §11).
            this.byPath.set(resolvedPath, { store, lastAccessedAt: touch ? this.now() : STALE_SENTINEL_MS, names: new Set([workspace]) });
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
     * 3.21 step 2 part 2 — swap this workspace's cached store for a fresh
     * `VerbatimStore` (LanceDB) after a background SQLite → LanceDB
     * promotion COMMITS. Called as the `onLancePromoted` callback threaded
     * into every `SqliteVerbatimStore` this resolver opens.
     *
     * Opens and initializes the NEW store BEFORE touching the cache entry
     * or closing the old one — a concurrent `getOrOpen()` must never
     * observe a gap where neither store is cached, and the old SQLite
     * store keeps serving (its underlying file was already renamed aside
     * by the promotion, but its open file descriptor stays valid on POSIX,
     * same as any other rename-out-from-under-an-open-fd) until the
     * instant this swap lands.
     *
     * Best-effort: a workspace not currently cached (never opened, or
     * already evicted) is a no-op — the NEXT `getOrOpen()` for it will
     * resolve `vectorEngine` fresh (already flipped to 'lance' by the
     * promotion trigger by the time this callback fires) and open the
     * right engine on its own, with nothing to swap.
     */
    async swapToLance(workspace: string): Promise<void> {
        let resolvedPath: string;
        try {
            resolvedPath = getWorkspacePath(workspace, this.home);
        } catch {
            return;
        }
        const entry = this.byPath.get(resolvedPath);
        if (!entry) return;
        const role = typeof this.vectorStoreRole === 'function' ? this.vectorStoreRole(resolvedPath) : this.vectorStoreRole;
        const fresh = new VerbatimStore(resolvedPath, this.embeddingProvider, { role, strictFingerprintCheck: this.strictFingerprintCheck ?? false });
        try {
            await fresh.initialize();
        } catch (err) {
            log.error(`[WorkspaceVerbatimResolver] swapToLance: failed to open the promoted LanceDB store for "${workspace}" at ${resolvedPath} — keeping the old SQLite handle live: ${(err as Error).message}`);
            return;
        }
        const old = this.byPath.get(resolvedPath);
        // Re-check after the await: only swap if the entry is still the
        // SAME one we decided to promote (a concurrent evictIdle/
        // closeWorkspace/another swap could have already replaced it).
        if (old !== entry) {
            const closable = fresh as unknown as { close?: () => Promise<void> | void };
            if (typeof closable.close === 'function') {
                try { await closable.close(); } catch { /* best-effort */ }
            }
            return;
        }
        this.byPath.set(resolvedPath, { store: fresh, lastAccessedAt: entry.lastAccessedAt, names: entry.names });
        log.info(`[WorkspaceVerbatimResolver] swapped "${workspace}" to its promoted LanceDB store.`);
        const closable = entry.store as unknown as { close?: () => Promise<void> | void };
        if (typeof closable.close === 'function') {
            try { await closable.close(); } catch { /* best-effort */ }
        }
    }

    /** True if ANY name associated with this cache entry has pending
     *  embed-queue or outbox work — the eviction guardrail. Fail-open
     *  (returns false, i.e. "safe to evict") when no guardrail is wired or
     *  the underlying store doesn't implement the optional query. */
    private async hasPendingWork(names: Iterable<string>): Promise<boolean> {
        for (const name of names) {
            if (this.guardrails.hasPendingEmbeds?.(name)) return true;
            if (this.guardrails.hasPendingOutbox && await this.guardrails.hasPendingOutbox(name)) return true;
        }
        return false;
    }

    /**
     * (c) Evict cached workspaces idle longer than `idleMs` relative to
     * `nowMs`. Skips pinned paths, paths with an in-flight open, and —
     * the database guardrail — any workspace with pending embed-queue or
     * outbox work (eviction releases handles, never queued data).
     *
     * Closes concurrently (`Promise.allSettled`), not sequentially: each
     * workspace's store lives in its own directory with its own handles,
     * so there is nothing shared for a sequential await to protect — same
     * reasoning as `localGraphRegistry.ts`'s `evictIdle`. Returns the
     * number of stores actually closed.
     */
    async evictIdle(nowMs: number, idleMs: number = IDLE_TTL_MS): Promise<number> {
        const candidates: Array<[string, CacheEntry]> = [];
        for (const [p, entry] of this.byPath) {
            if (this.pinnedPaths.has(p)) continue;
            if (this.inflight.has(p)) continue;
            if (nowMs - entry.lastAccessedAt <= idleMs) continue;
            candidates.push([p, entry]);
        }
        if (candidates.length === 0) return 0;
        const results = await Promise.allSettled(candidates.map(async ([p, entry]) => {
            if (await this.hasPendingWork(entry.names)) {
                log.info(`[WorkspaceVerbatimResolver] skipping idle-eviction for ${[...entry.names].join(',')} — pending embed/outbox work`);
                return false;
            }
            // Opus review F2 — re-verify SYNCHRONOUSLY (no await between the
            // check and the delete) that nothing raced us during the
            // hasPendingWork() await above: a concurrent getOrOpen(name) could
            // have touched lastAccessedAt (still the SAME entry object) or —
            // after a prior eviction — replaced it with a freshly-opened one
            // (a DIFFERENT entry object at this path). Either way, evicting
            // now would close a store a caller just started depending on.
            if (this.byPath.get(p) !== entry || !(nowMs - entry.lastAccessedAt > idleMs)) return false;
            // Delete BEFORE awaiting close() — a getOrOpen() that arrives
            // during the close() await must miss the cache and open a FRESH
            // store rather than receive this one moments before it closes.
            // Two LanceDB handles briefly open on one directory is fine
            // (MVCC reads); the old handle's own write-drain (VerbatimStore
            // (a)) protects any of its own in-flight work.
            this.byPath.delete(p);
            const closable = entry.store as unknown as { close?: () => Promise<void> | void };
            if (typeof closable.close === 'function') await closable.close();
            return true;
        }));
        return results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
    }

    /**
     * Explicitly close one workspace's store by name (an operator/host
     * action, not the idle sweep). Refuses — returns `false` — for a
     * pinned (boot-owned) path, or when the guardrail finds pending
     * embed/outbox work for it; the caller can retry later in either case.
     * Returns `true` when a handle was actually closed, and also when
     * nothing was open for it (nothing to do).
     */
    async closeWorkspace(name: string): Promise<boolean> {
        let resolvedPath: string;
        try {
            resolvedPath = getWorkspacePath(name, this.home);
        } catch {
            return false;
        }
        if (this.pinnedPaths.has(resolvedPath)) return false;
        const entry = this.byPath.get(resolvedPath);
        if (!entry) return true; // nothing open — already "closed"
        if (await this.hasPendingWork(entry.names)) return false;
        // Opus review F2 — same race as evictIdle: re-verify synchronously
        // (no await between check and delete) that this is still the SAME
        // entry the hasPendingWork() await above examined, then delete
        // BEFORE awaiting close() so a concurrent getOrOpen() opens fresh
        // instead of receiving a store that is about to close.
        if (this.byPath.get(resolvedPath) !== entry) return false;
        this.byPath.delete(resolvedPath);
        const closable = entry.store as unknown as { close?: () => Promise<void> | void };
        if (typeof closable.close === 'function') await closable.close();
        return true;
    }

    /**
     * Close + drop every lazily-opened store. Pinned (boot-owned) paths
     * are dropped from the map but NOT closed — the daemon shutdown drain
     * closes the boot VerbatimStore. Best-effort per store. Also stops the
     * eviction sweep — this is the process-teardown path, not a
     * runtime eviction, so the guardrail does not apply here (the daemon
     * is exiting either way; the (a) write-drain inside close() itself is
     * what keeps this safe for any in-flight write).
     */
    async closeAll(): Promise<void> {
        this.stopEvictionSweep();
        for (const [p, entry] of this.byPath.entries()) {
            if (this.pinnedPaths.has(p)) continue;
            const closable = entry.store as unknown as { close?: () => Promise<void> | void };
            if (typeof closable.close === 'function') {
                try { await closable.close(); } catch { /* best-effort */ }
            }
        }
        this.byPath.clear();
        this.inflight.clear();
    }
}
