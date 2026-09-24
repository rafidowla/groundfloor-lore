/**
 * localGraphRegistry.ts — multi-workspace graph engine manager.
 *
 * Holds a lazy-opened Map of (workspace name → CacheEntry), each entry
 * holding that workspace's open SurrealDB `SurrealGraph`. (A prior local
 * graph implementation's entries existed here until it was removed,
 * 2026-08-21; a workspace that still declares `graphEngine: 'kuzu'` now fails LOUDLY at
 * `getGraphHandle` — see `legacyGraphEngineRemovedError` — rather than silently
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
import { SqliteGraph } from './sqliteGraph.js';
import { disposeAccessTracker } from './accessTracker.js';
import type { WorkspaceGraph } from './openWorkspaceGraph.js';
import {
    resolveWorkspaceGraphEngine,
    legacyGraphEngineRemovedError,
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
     * The graph engine for this workspace (SurrealDB or, 3.21 step 1d,
     * SQLite — whichever `graphEngine` selects). Null until first opened;
     * `getGraphHandle` fills it. Field name kept as `surreal` for a
     * minimal diff against the pre-3.21 registry; it holds either engine.
     */
    surreal: WorkspaceGraph | null;
}

function parseRegistryEnvMs(raw: string | undefined, fallback: number): number {
    if (!raw || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Access-kind option threaded through the registry's accessors.
 *  `touch: false` marks BACKGROUND/MAINTENANCE access — see `ensureEntry`'s
 *  doc comment. Default (omitted / `true`) is ordinary user access. */
export interface AccessOpts {
    touch?: boolean;
}

/** `lastAccessedAt` given to an entry OPENED (not merely touched) by
 *  background/maintenance access (`{ touch: false }`) with no prior cache
 *  entry — epoch 0 guarantees `nowMs - lastAccessedAt > idleMs` at the very
 *  next eviction sweep tick for any positive TTL, so a sweep that reopens an
 *  idle/evicted workspace to do its work doesn't thereby grant it a fresh
 *  full-TTL lease. */
const STALE_SENTINEL_MS = 0;

/** SP-11 — entries idle longer than this are closed by the periodic
 *  sweep. Each open workspace holds a surrealkv directory lock + driver
 *  state + a LanceDB handle (~10–50MB RSS).
 *
 *  DEFAULT CHANGED 2026-09-18 (docs/PERFORMANCE-MEMORY.md §9/§11):
 *  `@surrealdb/node` 3.0.3 never frees a datastore on `close()`, so
 *  evicting an idle graph and reopening it later doesn't return that
 *  ~10-50MB — it COSTS an extra ~100MB per reopen, unbounded, because the
 *  previous open's native allocation is never released. Idle graph
 *  eviction is therefore net-negative on this driver: 0 (disabled) is now
 *  the default, so a workspace opened once stays open for the life of the
 *  process instead of being evicted-then-reopened at a cost the eviction
 *  was supposed to be saving. A positive value restores the pre-3.20.0
 *  sweep behaviour (for a host that has verified its `@surrealdb/node`
 *  doesn't have this leak, or that prefers bounded idle memory over
 *  reopen cost for its own reasons). This does NOT affect
 *  `LORE_MAX_OPEN_WORKSPACES` over-cap LRU eviction (docs/CONFIGURATION.md)
 *  or the vector-store (`WorkspaceVerbatimResolver`) idle sweep, which
 *  stays on LanceDB, a driver that DOES release memory on close() — see
 *  that class's own IDLE_TTL_MS, unchanged by this file.
 *
 *  hc-registry-idle-sweep-hardcoded (NW-7c): env override LORE_REGISTRY_IDLE_TTL_MS.
 *  0 or unset = idle eviction disabled (this file's `startEvictionSweep()`
 *  arms no timer); any positive value re-enables the sweep at that TTL.
 *  `evictIdle()` itself is unaffected — it stays callable directly with an
 *  explicit `idleMs` (e.g. `evictIdle(now, 0)` to force-evict everything
 *  idle-eligible right now) regardless of this default. */
const IDLE_WORKSPACE_TTL_MS: number = parseRegistryEnvMs(process.env.LORE_REGISTRY_IDLE_TTL_MS, 0);
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

    /**
     * Defect 3 follow-up (3.20.2) — the home this registry's workspaces.json
     * reads are actually scoped to (an embedded instance's own `dataHome`,
     * or the process-wide `loreHome()` for local/cloud). Public so a caller
     * that already holds this registry (e.g. a cross-workspace fan-out) can
     * derive the SAME home for its own `listWorkspaceNames`/`getWorkspacePath`
     * calls instead of defaulting to the process-wide home and silently
     * reading a different workspaces.json than the registry it is paired with.
     */
    homeDir(): string {
        return this.home;
    }

    /** SP-11 — start the periodic idle-workspace eviction sweep.
     *  Idempotent; the timer is unref()'d so it never holds the process
     *  open. The daemon enables this; embedded/test uses drive evictIdle
     *  directly.
     *
     *  DEFAULT CHANGED 2026-09-18 — a no-op (arms NO timer) when
     *  `IDLE_WORKSPACE_TTL_MS` is 0 (the new default: unset
     *  `LORE_REGISTRY_IDLE_TTL_MS`). See that constant's own doc comment
     *  for why (docs/PERFORMANCE-MEMORY.md §9/§11 — idle graph eviction is
     *  net-negative on the current SurrealDB driver). A positive TTL (via
     *  the env override) restores the sweep exactly as before. */
    startEvictionSweep(): void {
        if (this.sweepTimer) return;
        if (IDLE_WORKSPACE_TTL_MS <= 0) return; // idle eviction disabled by default
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
        // Flush and drop THIS graph's access tracker before closing it. Its
        // pending stamps can only be written while the store is open, and a
        // tracker left armed on a closed graph is a leak (pre-3.18.2 it was
        // worse: the flush re-opened the store — see surrealGraph.ts
        // `stampAccessTimes`). Idle eviction reaches here too, so a long-lived
        // daemon would otherwise accumulate one armed tracker per evicted
        // workspace.
        if (entry.surreal) { try { await disposeAccessTracker(entry.surreal); } catch { /* best-effort */ } }
        // The Surreal handle's directory lock is released asynchronously by
        // the driver — best-effort close is all we can do here.
        if (entry.surreal) { try { await entry.surreal.close(); } catch { /* best-effort */ } }
        return !!entry.surreal;
    }

    /** SP-11 — evict cached workspaces idle longer than `idleMs` relative
     *  to `nowMs`. Returns the number of entries dropped. Closes the
     *  underlying SurrealGraph handles. Directly unit-testable.
     *
     *  The `closeEntry` calls below run concurrently (`Promise.allSettled`),
     *  not one at a time: each workspace's store lives in its own directory
     *  with its own lock, so there is no shared resource for a sequential
     *  await to protect, and a settle-bound close (~25-150ms — see
     *  surrealSettle.ts) otherwise taxes a daemon with many idle workspaces
     *  once per workspace, serially. `closeEntry`'s alias-dedup (`cache.get`
     *  / `cache.delete` / the scan over `cache.values()`) is entirely
     *  synchronous ahead of its own `await`, so `Array.map` invoking every
     *  call before any of them yields preserves the exact dedup ordering the
     *  old sequential `for` loop had — only the awaited closes themselves now
     *  overlap. */
    async evictIdle(nowMs: number, idleMs: number = IDLE_WORKSPACE_TTL_MS): Promise<number> {
        const stale: string[] = [];
        for (const [name, entry] of this.cache) {
            if (entry.pinned) continue; // never evict the boot graph
            if (nowMs - entry.lastAccessedAt > idleMs) stale.push(name);
        }
        const results = await Promise.allSettled(stale.map((name) => this.closeEntry(name)));
        let closed = 0;
        results.forEach((result, i) => {
            if (result.status === 'fulfilled' && result.value) closed++;
            else this.cache.delete(stale[i]); // best-effort cleanup; closeEntry already deletes on every other path
        });
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
     * runs its own alias scan below and shares that handle.
     *
     * `opts.touch` (default true) — pass `{ touch: false }` for BACKGROUND/
     * MAINTENANCE access (the daemon's own periodic sweeps) that must NOT
     * count as user activity: a cache-hit then returns the entry WITHOUT
     * bumping `lastAccessedAt`, so a sweep that merely glances at an idle
     * workspace can't keep it alive forever. See docs/PERFORMANCE-MEMORY.md
     * §11 — the daily retention sweep's fan-out (daemonTimers.ts) touched
     * every registered workspace ~60s after boot, defeating idle eviction at
     * any TTL the fan-out interval could reach before the next checkpoint. */
    private async ensureEntry(workspace: string, opts: AccessOpts = {}): Promise<CacheEntry> {
        const touch = opts.touch !== false;
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
            if (touch) cached.lastAccessedAt = this.now(); // SP-11 — touch for LRU (user access only).
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
                if (touch) fresh.lastAccessedAt = this.now();
                return fresh;
            }
            // BACKGROUND-open (touch:false) of a workspace with no bare entry
            // yet gets the STALE sentinel, not `this.now()` — a maintenance
            // sweep that opens a cold workspace must not grant it a fresh
            // full-TTL lease; the entry stays eligible for the very next
            // eviction sweep tick once the sweep's own work finishes. See
            // getGraphHandle's `open()` for the matching fix on the engine
            // open path (docs/PERFORMANCE-MEMORY.md §11 — this is what the
            // 30→70 graph-fd growth during the TTL=40000 idle wait traced
            // back to: the fan-out re-opening evicted workspaces with a
            // fresh `lastAccessedAt` before this fix).
            const entry: CacheEntry = { path: resolvedPath, lastAccessedAt: touch ? this.now() : STALE_SENTINEL_MS, pinned: false, surreal: null };
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
     * (`LegacyGraphEngineRemovedError` — a legacy graph engine declaration is no
     * longer supported), and silently substituting SurrealDB would read and
     * write the WRONG store while the workspace's real data sits in
     * `.lore/graph` — the exact silent-fallback bug class behind the
     * pm-scope-app incident.
     *
     * `opts.touch` (default true) — see `ensureEntry`'s doc comment.
     * `{ touch: false }` is for the daemon's own background sweeps
     * (daemonTimers.ts's per-workspace fan-outs); ordinary callers should
     * never pass it.
     */
    async getGraphHandle(workspace: string, opts: AccessOpts = {}): Promise<WorkspaceGraph> {
        const engineKind = resolveWorkspaceGraphEngine(workspace, this.home);
        if (engineKind === 'kuzu') {
            legacyGraphEngineRemovedError(workspace, 'LocalGraphRegistry.getGraphHandle');
        }

        const touch = opts.touch !== false;
        const entry = await this.ensureEntry(workspace, opts);
        if (entry.surreal) return entry.surreal;

        // Path dedup: reuse another name's Surreal handle on this path
        // rather than open a second one (lock contention — see below).
        for (const [otherName, other] of this.cache.entries()) {
            if (otherName !== workspace && other.path === entry.path && other.surreal) {
                const at = touch ? this.now() : other.lastAccessedAt;
                if (touch) other.lastAccessedAt = at;
                this.cache.set(workspace, { path: entry.path, lastAccessedAt: at, pinned: other.pinned, surreal: other.surreal });
                return other.surreal;
            }
        }

        // Serialize the open on the SAME chain as entry creation. Two
        // handles on one surrealkv directory contend on its lock, and the
        // driver's lock release is asynchronous (engines/
        // surreal/surrealConnection.ts), so a concurrent double-open would
        // burn the whole retry budget before failing. SqliteGraph has no
        // such contention (better-sqlite3 is synchronous, one process-local
        // handle), but sharing the same chain keeps the entry-creation race
        // guard identical for both engines rather than forking it.
        const open = async (): Promise<WorkspaceGraph> => {
            const fresh = this.cache.get(workspace);
            if (fresh?.surreal) return fresh.surreal;
            const surreal: WorkspaceGraph = engineKind === 'sqlite'
                ? new SqliteGraph(entry.path, { workspaceId: workspace })
                : new SurrealGraph(entry.path, { workspaceId: workspace });
            await surreal.initialize();
            // Re-read: the entry may have been replaced while we awaited.
            const target = this.cache.get(workspace);
            if (!target || target.path !== entry.path) {
                // The workspace moved or was evicted under us. Close what we
                // just opened instead of leaking a native handle + its lock.
                await surreal.close().catch(() => undefined);
                throw new Error(
                    `[LocalGraphRegistry] workspace '${workspace}' moved while opening its `
                    + `${engineKind === 'sqlite' ? 'SQLite' : 'SurrealDB'} graph — retry the operation`,
                );
            }
            target.surreal = surreal;
            // Background open (touch:false): stale sentinel, not `this.now()`
            // — see the matching comment in ensureEntry's `create()`. Without
            // this, a maintenance fan-out reopening an EVICTED workspace
            // handed it a fresh full-TTL lease, which is exactly what made
            // graph fds grow 30→70 during a TTL=40000 idle wait (the sweep's
            // own reopen kept re-arming the clock every pass).
            target.lastAccessedAt = touch ? this.now() : STALE_SENTINEL_MS;
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
        // SurrealGraph and SqliteGraph are the only two local engines left.
        if (!(graph instanceof SurrealGraph) && !(graph instanceof SqliteGraph)) {
            // Loudly, not silently: a no-op prime leaves the registry to open
            // its OWN handle on the same directory, which is a lock fight on
            // surrealkv (or a redundant SQLite open).
            throw new Error(
                `[LocalGraphRegistry] prime('${workspace}'): unrecognised graph implementation `
                + `'${graph.constructor?.name ?? 'anonymous'}'. Only SurrealGraph/SqliteGraph `
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
    async tableStorageFor(workspace: string, opts: AccessOpts = {}): Promise<ITableStorage> {
        // A SQLite file keyed on the workspace PATH, not a graph substrate —
        // only needs the entry (gate + path), never an engine open.
        const entry = await this.ensureEntry(workspace, opts);
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
     *
     * The alias-dedup decision (which name owns the one close for a shared
     * `SurrealGraph`) is made synchronously, up front, for every entry before
     * any awaiting starts — exactly the ordering the old sequential `for`
     * loop had, since none of `cache.get`/`delete`/`has`/`add` ever yield.
     * Only the actual closes (native handle + session-cache flush + table
     * storage) run concurrently afterwards, via `Promise.allSettled`: each
     * lives in its own workspace directory with its own lock, so nothing here
     * shares a resource a sequential await was protecting. This matters at
     * scale — a settle-bound `SurrealGraph.close()` (~25-150ms, see
     * surrealSettle.ts) otherwise serializes into seconds of daemon-shutdown
     * latency once a workspace count gets into the dozens.
     */
    async disposeAll(): Promise<void> {
        this.stopEvictionSweep();
        const closedGraphs = new Set<WorkspaceGraph>();
        const closes: Array<Promise<void>> = [];
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
            const { surreal, sessionCache, tableStorage } = entry;
            closes.push((async () => {
                if (surreal) { try { await surreal.close(); } catch { /* best-effort */ } }
                // Flush before closing anything: an unflushed hot-session cache is
                // silently lost work, which is what TW-7e was about.
                if (sessionCache) { try { sessionCache.flushNow(); } catch { /* best-effort */ } }
                if (tableStorage) {
                    try { (tableStorage as unknown as { close?: () => void }).close?.(); }
                    catch { /* best-effort */ }
                }
            })());
        }
        await Promise.allSettled(closes);
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
