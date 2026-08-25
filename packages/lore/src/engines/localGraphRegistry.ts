/**
 * localGraphRegistry.ts — multi-workspace graph engine manager.
 *
 * Holds a lazy-opened Map of (workspace name → CacheEntry), each entry
 * holding that workspace's open SurrealDB `SurrealGraph`. (Kùzu `LocalGraph`
 * entries existed here until the Kùzu removal, Phase 3d 2026-08-21; a
 * workspace that still declares `graphEngine: 'kuzu'` now fails LOUDLY at
 * `getGraphHandle` — see `kuzuEngineRemovedError` — rather than silently
 * reading an empty store.) HTTP write handlers ask the registry for the
 * handle corresponding to the per-request `workspace` arg (or fall back to
 * the active workspace when omitted) before doing the upsertNode / addEdge /
 * deleteNode call — so writes land in the REQUESTED workspace's directory,
 * not wherever the boot-bound graph happens to point.
 *
 * Cache invalidation:
 *   The registry watches `workspaces.json` mtime. When the file is
 *   rewritten between requests (e.g. `lore workspaces switch`), the
 *   NEXT lookup re-reads the registry and drops/re-opens any cached
 *   instance whose path has changed. Instances whose path is unchanged
 *   are kept (avoid thrashing surrealkv re-opens).
 *
 * Concurrency:
 *   `getGraphHandle` is async and serializes engine opens on one chain,
 *   so multiple simultaneous requests for workspace X get the same
 *   SurrealGraph instance once it's ready.
 */

import * as fs from 'node:fs';

import * as path from 'node:path';

import { SessionCacheManager } from './sessionCacheManager.js';
import { createTableStorage } from './tableStorageFactory.js';
import type { ITableStorage } from '../contracts/tables.js';
import { SurrealGraph } from './surrealGraph.js';
import type { WorkspaceGraph } from './openWorkspaceGraph.js';
import {
    resolveWorkspaceGraphEngine,
    kuzuEngineRemovedError,
    type GraphEngineKind,
} from './graphEngineSelector.js';
import {
    getWorkspacePath,
    listWorkspaceNames,
    getActiveWorkspaceName,
} from '../config/workspaces.js';
import { loreHome } from '../config/loreHome.js';
import { assertWorkspaceOpenAllowed } from '../security/routeWorkspaceBinding.js';

interface CacheEntry {
    /**
     * Path-backed substrates that are NOT the graph, memoized per workspace:
     * a SQLite file and a JSON file, both keyed on the workspace path alone
     * — neither is graph-engine work. Live here because the registry is
     * already the per-workspace eviction/disposal owner. Memoization is
     * load-bearing: TW-7e requires exactly ONE SessionCacheManager per
     * `hot_session.json` (two is last-writer-wins), and a second
     * SqliteTableStorage would be a second owner of the schema-cache sidecar.
     */
    tableStorage?: ITableStorage;
    sessionCache?: SessionCacheManager;
    /** Absolute path the graph was constructed with — used to detect
     *  workspaces.json edits that move a workspace's data on disk. */
    path: string;
    /** SP-11 — ms-since-epoch of the last accessor/prime touch. Drives
     *  idle LRU eviction so a 50-workspace daemon doesn't keep every
     *  SurrealGraph (with its surrealkv directory lock + LanceDB handle)
     *  open forever. */
    lastAccessedAt: number;
    /** SP-11 — pinned entries are never evicted/closed by the registry.
     *  The boot-bound active graph is primed + pinned because it is the
     *  same SurrealGraph singleton the daemon's GET handlers and the
     *  shutdown drain own; the registry must not close it underneath
     *  them. Lazy-opened workspaces are unpinned and fully evictable. */
    pinned: boolean;
    /**
     * The SurrealDB graph engine for this workspace. Null until first
     * opened; `getGraphHandle` fills it.
     */
    surreal: SurrealGraph | null;
}

function parseRegistryEnvMs(raw: string | undefined, fallback: number): number {
    if (!raw || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** SP-11 — entries idle longer than this are closed by the periodic
 *  sweep. Each open workspace holds a surrealkv directory lock + driver
 *  state + a LanceDB handle (~10–50MB RSS).
 *
 *  hc-registry-idle-sweep-hardcoded (NW-7c): env override LORE_REGISTRY_IDLE_TTL_MS. */
const IDLE_WORKSPACE_TTL_MS: number = parseRegistryEnvMs(process.env.LORE_REGISTRY_IDLE_TTL_MS, 30 * 60 * 1000);
/** SP-11 — how often the optional background eviction sweep runs.
 *
 *  hc-registry-idle-sweep-hardcoded (NW-7c): env override LORE_REGISTRY_SWEEP_MS. */
const REGISTRY_SWEEP_INTERVAL_MS: number = parseRegistryEnvMs(process.env.LORE_REGISTRY_SWEEP_MS, 10 * 60 * 1000);

export class WorkspaceNotFoundError extends Error {
    constructor(
        public readonly requested: string,
        public readonly known: string[],
    ) {
        super(`workspace_not_found: "${requested}" (known: ${known.join(", ")})`);
        this.name = "WorkspaceNotFoundError";
    }
}

export class LocalGraphRegistry {
    private cache = new Map<string, CacheEntry>();
    /** RA2-reaudit2 — serializes the open critical section (entry creation
     *  and engine construction/initialize) across DISTINCT workspaces, so a
     *  burst of concurrent first-time opens can't create two divergent cache
     *  entries or two SurrealGraph handles contending on one surrealkv
     *  directory lock. This tail never rejects, so one failed open can't
     *  break the chain for the next waiter. */
    private openChain: Promise<unknown> = Promise.resolve();
    /** Last-observed workspaces.json mtime; reset cache when it changes. */
    private workspacesJsonMtime: number | null = null;
    /** SP-11 — clock seam so the idle-eviction sweep is unit-testable
     *  without real wall time. */
    private readonly now: () => number;
    /** SP-11 — background idle-eviction timer (when autoEvict). */
    private sweepTimer: NodeJS.Timeout | null = null;
    /** TW-2a — instance-scoped Lore data root. Threaded into every
     *  workspaces.json read (getWorkspacePath / listWorkspaceNames /
     *  getActiveWorkspaceName) and the mtime watch so two embedded
     *  instances with distinct `dataDir` resolve disjoint on-disk graphs
     *  instead of colliding on the process-global LORE_HOME. Defaults to
     *  loreHome() (env), preserving daemon behavior exactly. */
    private readonly home: string;

    constructor(opts: { now?: () => number; autoEvict?: boolean; home?: string } = {}) {
        this.now = opts.now ?? Date.now;
        this.home = opts.home ?? loreHome();
        if (opts.autoEvict) this.startEvictionSweep();
    }

    /** TW-2a — workspaces.json path under this instance's home. */
    private workspacesJsonPath(): string {
        return path.join(this.home, 'workspaces.json');
    }

    /** SP-11 — start the periodic idle-workspace eviction sweep.
     *  Idempotent; the timer is unref()'d so it never holds the process
     *  open. The daemon enables this; embedded/test uses drive evictIdle
     *  directly. */
    startEvictionSweep(): void {
        if (this.sweepTimer) return;
        const t = setInterval(() => { void this.evictIdle(this.now(), IDLE_WORKSPACE_TTL_MS); }, REGISTRY_SWEEP_INTERVAL_MS);
        if (typeof t.unref === 'function') t.unref();
        this.sweepTimer = t;
    }

    /** SP-11 — stop the periodic eviction sweep (graceful shutdown). */
    stopEvictionSweep(): void {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }

    /**
     * re-audit 2026-06-25 — public close-by-name so callers that delete a
     * workspace's on-disk data (e.g. `lore maintain` ephemeral-workspace
     * cleanup) can FIRST close+drop any cached graph handle, rather than
     * rmSync-ing the data dir out from under an open store. Returns true
     * when a handle was physically closed; false when no entry / pinned /
     * aliased (caller should not delete the dir in those cases).
     */
    async closeWorkspace(name: string): Promise<boolean> {
        // RA2-reaudit2 — return "is it now safe to delete this workspace's data
        // dir?": true when there is no cached handle (nothing open) OR we
        // physically closed it; false ONLY when a handle remains that we could
        // NOT close (pinned/aliased) — the caller must then NOT rmSync the
        // dir out from under the open store. (closeEntry alone returns false
        // for the not-cached case too, which would wrongly block normal
        // deletes.)
        if (!this.cache.get(name)) return true;
        return this.closeEntry(name);
    }

    /** SP-11 — close + drop a cached entry, but ONLY close the underlying
     *  SurrealGraph when no OTHER cached name aliases the same instance
     *  (the path-dedup in getGraphHandle can map several names → one
     *  graph; closing it while an alias still references it would break
     *  the alias). Returns true when a handle was physically closed. */
    private async closeEntry(name: string): Promise<boolean> {
        const entry = this.cache.get(name);
        if (!entry) return false;
        if (entry.pinned) return false; // SP-11 — never close the boot graph.
        this.cache.delete(name);
        let aliased = false;
        for (const other of this.cache.values()) {
            if (entry.surreal && other.surreal === entry.surreal) { aliased = true; break; }
        }
        if (aliased) return false;
        // The Surreal handle's directory lock is released asynchronously by
        // the driver — best-effort close is all we can do here.
        if (entry.surreal) { try { await entry.surreal.close(); } catch { /* best-effort */ } }
        return !!entry.surreal;
    }

    /** SP-11 — evict cached workspaces idle longer than `idleMs` relative
     *  to `nowMs`. Returns the number of entries dropped. Closes the
     *  underlying SurrealGraph handles. Directly unit-testable. */
    async evictIdle(nowMs: number, idleMs: number = IDLE_WORKSPACE_TTL_MS): Promise<number> {
        const stale: string[] = [];
        for (const [name, entry] of this.cache) {
            if (entry.pinned) continue; // never evict the boot graph
            if (nowMs - entry.lastAccessedAt > idleMs) stale.push(name);
        }
        let closed = 0;
        for (const name of stale) {
            if (await this.closeEntry(name)) closed++;
            else this.cache.delete(name);
        }
        return closed;
    }

    /** SP-11 test/observability hook — current open-workspace count. */
    openCount(): number {
        return this.cache.size;
    }

    /**
     * Resolve — creating a bare one if needed — the cache entry for
     * `workspace`, WITHOUT opening the engine: the gate + path resolution
     * + path-change invalidation every accessor needs (`getGraphHandle`,
     * `tableStorageFor`, `sessionCacheFor`).
     *
     * Does NOT alias-dedup a bare entry across names: no two names share a
     * path today, and it self-corrects — the first engine either name opens
     * runs its own alias scan below and shares that handle. */
    private async ensureEntry(workspace: string): Promise<CacheEntry> {
        // Wave 4.1 — substrate chokepoint (→ 403 on a request's non-target
        // workspace); slotless callers unaffected.
        assertWorkspaceOpenAllowed(workspace);
        this.maybeInvalidate();

        // Resolve the path FIRST so unknown names throw before we touch
        // the cache. getWorkspacePath throws workspace_not_found.
        let resolvedPath: string;
        try {
            resolvedPath = getWorkspacePath(workspace, this.home);
        } catch {
            const known = listWorkspaceNames(this.home);
            throw new WorkspaceNotFoundError(workspace, known);
        }

        const cached = this.cache.get(workspace);
        if (cached && cached.path === resolvedPath) {
            cached.lastAccessedAt = this.now(); // SP-11 — touch for LRU.
            return cached;
        }

        // If cached but path changed → close + drop the stale entry. Close
        // only when no alias shares the instance AND the entry isn't the
        // pinned boot graph; either way the stale name is dropped so a
        // fresh entry opens against the new path.
        if (cached && cached.path !== resolvedPath) {
            const shared = [...this.cache.values()].some(
                (e) => e !== cached && !!cached.surreal && e.surreal === cached.surreal,
            );
            this.cache.delete(workspace);
            if (!shared && !cached.pinned) {
                // The moved workspace's Surreal handle points at the OLD
                // path; leaving it open would hold that directory's lock.
                if (cached.surreal) { try { await cached.surreal.close(); } catch { /* best-effort */ } }
            }
        }

        // First-ever access to this workspace (no cached entry at any
        // engine). Serialize creation on the SAME chain every engine-open
        // already uses, so a concurrent ensureEntry/getGraphHandle for this
        // workspace can't create two divergent bare entries.
        const create = async (): Promise<CacheEntry> => {
            const fresh = this.cache.get(workspace);
            if (fresh && fresh.path === resolvedPath) {
                fresh.lastAccessedAt = this.now();
                return fresh;
            }
            const entry: CacheEntry = { path: resolvedPath, lastAccessedAt: this.now(), pinned: false, surreal: null };
            this.cache.set(workspace, entry);
            return entry;
        };
        const creating = this.openChain.then(create, create);
        this.openChain = creating.then(() => undefined, () => undefined);
        return creating;
    }

    /**
     * Phase 3 — resolve the GRAPH SUBSTRATE handle for `workspace`: the
     * engine that owns its nodes and edges. SurrealDB when `graphEngine` is
     * absent or `'surreal'`. THE ACCESSOR TO USE for anything that reads or
     * writes nodes and edges.
     *
     * An EXPLICIT `graphEngine: 'kuzu'` declaration fails LOUDLY
     * (`KuzuEngineRemovedError`): Kùzu support was removed 2026-08-21, and
     * silently substituting SurrealDB would read and write the WRONG store
     * while the workspace's real Kùzu data sits in `.lore/graph` — the
     * exact silent-fallback bug class behind the pm-scope-app incident.
     */
    async getGraphHandle(workspace: string): Promise<WorkspaceGraph> {
        if (resolveWorkspaceGraphEngine(workspace, this.home) === 'kuzu') {
            kuzuEngineRemovedError(workspace, 'LocalGraphRegistry.getGraphHandle');
        }

        const entry = await this.ensureEntry(workspace);
        if (entry.surreal) return entry.surreal;

        // Path dedup: reuse another name's Surreal handle on this path
        // rather than open a second one (lock contention — see below).
        for (const [otherName, other] of this.cache.entries()) {
            if (otherName !== workspace && other.path === entry.path && other.surreal) {
                const at = this.now();
                other.lastAccessedAt = at;
                this.cache.set(workspace, { path: entry.path, lastAccessedAt: at, pinned: other.pinned, surreal: other.surreal });
                return other.surreal;
            }
        }

        // Serialize the Surreal open on the SAME chain as entry creation.
        // Two handles on one surrealkv directory contend on its lock, and
        // the driver's lock release is asynchronous (engines/
        // surreal/surrealConnection.ts), so a concurrent double-open would
        // burn the whole retry budget before failing.
        const open = async (): Promise<SurrealGraph> => {
            const fresh = this.cache.get(workspace);
            if (fresh?.surreal) return fresh.surreal;
            const surreal = new SurrealGraph(entry.path, { workspaceId: workspace });
            await surreal.initialize();
            // Re-read: the entry may have been replaced while we awaited.
            const target = this.cache.get(workspace);
            if (!target || target.path !== entry.path) {
                // The workspace moved or was evicted under us. Close what we
                // just opened instead of leaking a native handle + its lock.
                await surreal.close().catch(() => undefined);
                throw new Error(
                    `[LocalGraphRegistry] workspace '${workspace}' moved while opening its `
                    + 'SurrealDB graph — retry the operation',
                );
            }
            target.surreal = surreal;
            target.lastAccessedAt = this.now();
            return surreal;
        };
        const opening = this.openChain.then(open, open);
        this.openChain = opening.then(() => undefined, () => undefined);
        return opening;
    }

    /** 3.3 — already-open handle WITHOUT opening it (null if not open). */
    getOpenGraphHandle(workspace: string): WorkspaceGraph | null {
        const entry = this.cache.get(workspace);
        return entry ? (entry.surreal ?? null) : null;
    }

    /**
     * Which engine backs `workspace`'s nodes and edges. Diagnostic/reporting
     * surface — routes and tools should call `getGraphHandle` and stay
     * engine-agnostic rather than branching on this.
     */
    graphEngineFor(workspace: string): GraphEngineKind {
        return resolveWorkspaceGraphEngine(workspace, this.home);
    }

    /** True if `workspace` is registered in workspaces.json. */
    has(workspace: string): boolean {
        try {
            getWorkspacePath(workspace, this.home);
            return true;
        } catch {
            return false;
        }
    }

    /** Snapshot the names of all currently-cached workspaces. */
    openedNames(): string[] {
        return [...this.cache.keys()];
    }

    /**
     * Pre-seed the cache with the already-open boot graph for a workspace, so
     * the next accessor returns THAT instance instead of opening a second one
     * against the same files.
     *
     * Seating the boot Surreal handle here is what stops the daemon holding
     * two SurrealGraph instances on one surrealkv directory: that lock is
     * released asynchronously (DEC-SURREAL-BACKEND), so a second concurrent
     * open burns the retry budget and fails rather than merely wasting a
     * handle.
     */
    prime(workspace: string, graph: WorkspaceGraph): void {
        // Recognising the concrete class is correct here and nowhere else:
        // this is the one seam that accepts an already-constructed engine
        // from outside and has to file it into the engine-specific slot.
        // SurrealGraph is the only engine left (Kùzu removal Phase 3d).
        if (!(graph instanceof SurrealGraph)) {
            // Loudly, not silently: a no-op prime leaves the registry to open
            // its OWN handle on the same directory, which is a lock fight on
            // surrealkv.
            throw new Error(
                `[LocalGraphRegistry] prime('${workspace}'): unrecognised graph implementation `
                + `'${graph.constructor?.name ?? 'anonymous'}'. Only SurrealGraph `
                + 'can be primed — the cache files it in the engine-specific slot.',
            );
        }
        let resolvedPath: string;
        try {
            resolvedPath = getWorkspacePath(workspace, this.home);
        } catch {
            // If the workspace name isn't registered, prime is a no-op —
            // future getGraphHandle will throw the same
            // WorkspaceNotFoundError.
            return;
        }
        // SP-11 — pinned: this is the boot-bound graph owned by the
        // daemon's GET handlers + the shutdown drain; the registry must
        // never evict/close it.
        this.cache.set(workspace, { surreal: graph, path: resolvedPath, lastAccessedAt: this.now(), pinned: true });
        // Seed mtime so the next maybeInvalidate() doesn't immediately
        // bounce this primed entry on a never-checked-before signal.
        try {
            const stats = fs.statSync(this.workspacesJsonPath());
            this.workspacesJsonMtime = stats.mtimeMs;
        } catch {
            // No workspaces.json yet; the entry stays primed until the
            // file lands and a later edit triggers re-evaluation.
        }
    }

    /** Resolve the default workspace name (the active one in workspaces.json). */
    activeName(): string {
        return getActiveWorkspaceName(this.home);
    }

    /**
     * Drop all cached instances + stop the eviction sweep.
     *
     * SP-11 — only releases JS-side references; the UNPINNED, non-aliased
     * graphs' handles are deliberately NOT closed here: the pinned boot
     * graph is closed by the daemon's shutdown drain (graph.close()), and
     * lazily-opened siblings are closed by evictIdle during normal
     * operation. closeAll() is a reference-drop + timer-stop so it stays
     * synchronous and can't double-close the boot graph. Call
     * evictIdle(now, 0) first if you want every sibling handle physically
     * closed.
     */
    closeAll(): void {
        this.stopEvictionSweep();
        this.cache.clear();
    }

    /**
     * The workspace's collection/table store. Opens the workspace first, so
     * this inherits `ensureEntry`'s workspace-confinement gate — a caller
     * denied the workspace must not reach its tables either.
     */
    async tableStorageFor(workspace: string): Promise<ITableStorage> {
        // A SQLite file keyed on the workspace PATH, not a graph substrate —
        // only needs the entry (gate + path), never an engine open.
        const entry = await this.ensureEntry(workspace);
        entry.tableStorage ??= createTableStorage(entry.path);
        return entry.tableStorage;
    }

    /** The workspace's hot-session cache — a path-keyed manager; exactly
     *  ONE per `hot_session.json` (TW-7e single-writer; a second one on the
     *  same file reads stale and `disposeAll()` erases writes —
     *  `session-cache-sibling-instance-unit.ts`). */
    async sessionCacheFor(workspace: string): Promise<SessionCacheManager> {
        const entry = await this.ensureEntry(workspace);
        entry.sessionCache ??= new SessionCacheManager(entry.path);
        return entry.sessionCache;
    }

    /**
     * TW-7e (conc-dispose-leaks-lazy-opened-sibling-workspace-graphs) —
     * physically close every lazily-opened sibling graph on dispose.
     *
     * The shutdown drain closes the PINNED boot graph itself (graph.close()),
     * but lazily-opened siblings were only reference-dropped by closeAll(),
     * leaking their native handle + directory lock for the life of the host
     * process (acute in embedded mode where the host keeps running). This
     * closes each unpinned, non-aliased graph exactly once, stops the sweep,
     * and clears the map. The pinned boot graph is left for the drain's own
     * graph.close() so it isn't double-closed.
     *
     * await-able and idempotent. Each close is individually try/caught so one
     * failing handle can't strand the rest.
     */
    async disposeAll(): Promise<void> {
        this.stopEvictionSweep();
        const closedGraphs = new Set<SurrealGraph>();
        for (const [name, entry] of [...this.cache.entries()]) {
            if (entry.pinned) continue;          // boot graph closed by the drain
            // Alias dedup: getGraphHandle's path-dedup can map several names
            // onto one SurrealGraph; close it exactly once.
            if (entry.surreal) {
                if (closedGraphs.has(entry.surreal)) {  // alias of an already-closed graph
                    this.cache.delete(name);
                    continue;
                }
                closedGraphs.add(entry.surreal);
            }
            this.cache.delete(name);
            if (entry.surreal) { try { await entry.surreal.close(); } catch { /* best-effort */ } }
            // Flush before closing anything: an unflushed hot-session cache is
            // silently lost work, which is what TW-7e was about.
            if (entry.sessionCache) { try { entry.sessionCache.flushNow(); } catch { /* best-effort */ } }
            if (entry.tableStorage) {
                try { (entry.tableStorage as unknown as { close?: () => void }).close?.(); }
                catch { /* best-effort */ }
            }
        }
        this.cache.clear();
    }

    /**
     * Watch workspaces.json mtime. When it changes since the last
     * check, drop any cached entries whose path doesn't match the new
     * resolved path. This lets `lore workspaces switch` or hand-edits
     * take effect on the next request without a daemon restart.
     */
    private maybeInvalidate(): void {
        const p = this.workspacesJsonPath();
        let mtime: number;
        try {
            mtime = fs.statSync(p).mtimeMs;
        } catch {
            // No workspaces.json yet — leave cache as-is (boot-time
            // first-call will create it via loadWorkspaces()).
            return;
        }
        if (this.workspacesJsonMtime === null) {
            this.workspacesJsonMtime = mtime;
            return;
        }
        if (mtime === this.workspacesJsonMtime) return;
        this.workspacesJsonMtime = mtime;

        // mtime changed → check each cached entry's path against the
        // freshly-resolved workspace path. Drop mismatches.
        for (const [name, entry] of this.cache.entries()) {
            let nowPath: string;
            try {
                nowPath = getWorkspacePath(name, this.home);
            } catch {
                this.cache.delete(name);
                continue;
            }
            if (nowPath !== entry.path) {
                this.cache.delete(name);
            }
        }
    }
}
