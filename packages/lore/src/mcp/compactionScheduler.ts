/**
 * compactionScheduler.ts — scheduled LanceDB storage compaction (LOCAL/daemon
 * mode only).
 *
 * ## Problem
 *
 * `VerbatimStore.compact()` (engines/verbatimStore.ts) reclaims disk by
 * merging LanceDB fragments and pruning old versions — but pre-this-file it
 * only ran:
 *   1. After the consistency sweep's opt-in orphan-delete pass
 *      (`LORE_SWEEP_DELETE_ORPHANS=1`, default OFF), and
 *   2. From the manual `/api/health` cleanup endpoint (operator-triggered).
 *
 * Every LanceDB write (upsert, re-embed, delete, tombstone) commits a new
 * version and, above a fragment count, a new data file. With no scheduled
 * compaction, a long-running local daemon's `.lore/lancedb` grows unbounded
 * even when the sweep's delete pass is never opted in — ordinary write
 * traffic alone fragments the table over weeks/months.
 *
 * ## Fix
 *
 * A low-frequency (default daily) timer that walks every REGISTERED
 * workspace — not just the boot/active one — and calls `compact()` on each
 * workspace's own VerbatimStore, resolved via the same
 * `WorkspaceVerbatimResolver` the outbox replicator and embed queue use.
 * Mirrors `scheduleConsistencySweep` (diagnostics/sweeper.ts) and
 * `scheduleRetentionSweep` (retentionScheduler.ts):
 *   - env-overridable interval (`LORE_COMPACT_INTERVAL_MS`, default 24h).
 *   - opt-out escape hatch (`LORE_COMPACT_SCHEDULE_DISABLED=1`) for operators
 *     who compact externally (e.g. via `lore compact` cron or the `maintain`
 *     tool on their own cadence).
 *   - unref'd timer; async `stop()` awaits any in-flight pass.
 *   - one workspace at a time, fail-soft per workspace (a failed compact on
 *     workspace A must not block workspace B or crash the daemon).
 *
 * Gating: wired in server.ts under `startsDaemonTimers` — i.e. it NEVER
 * starts in embedded mode. Embedded hosts own their own maintenance; the
 * in-process equivalent is the `maintain` MCP tool
 * (mcp/tools/maintain.ts → engines/maintain/maintain.ts), which reaches
 * LanceDB compaction per-workspace via `LanceMaintainer.optimizeTable()`
 * (same underlying `table.optimize()` call `compact()` wraps) and is
 * reachable in-process through `LoreInstance.createMcpServer()` — no new API
 * surface needed for the embedded story.
 */

import { listWorkspaceNames } from '../config/workspaces.js';
import type { WorkspaceVerbatimResolver } from '../outbox/workspaceVerbatimResolver.js';

/** Narrow view of VerbatimStore this scheduler needs — kept minimal so
 *  tests can pass a fake without importing the real LanceDB-backed class. */
export interface CompactableStore {
    compact(opts?: { deleteUnverified?: boolean }): Promise<unknown>;
}

export interface CompactionSweepDeps {
    /** Resolves (lazily opens) the per-workspace VerbatimStore. Same
     *  resolver the outbox replicator + embed queue route through, so this
     *  pass reuses an already-open handle instead of opening a second
     *  LanceDB connection on the same directory. */
    resolver: Pick<WorkspaceVerbatimResolver, 'getOrOpen'>;
    /** Lists every registered workspace name. Defaults to
     *  config/workspaces.ts#listWorkspaceNames; injectable for tests. */
    listWorkspaces?: () => string[];
}

export interface CompactionSweepResult {
    /** Workspaces the pass attempted to compact. */
    attempted: string[];
    /** Workspaces that compacted without throwing. */
    succeeded: string[];
    /** workspace → error message, for workspaces whose compact() threw.
     *  Never blocks the remaining workspaces in the same pass. */
    failed: Record<string, string>;
}

/**
 * Run one storage-compaction pass across every registered workspace.
 * Bounded to ONE workspace at a time (sequential, not Promise.all) — compact
 * is already exclusive per store, but running many concurrently would still
 * spike native memory/IO across every workspace's LanceDB handle at once on
 * a multi-app local daemon. Fail-soft: one workspace's compact() throwing
 * never stops the sweep from reaching the rest.
 */
export async function runCompactionSweep(deps: CompactionSweepDeps): Promise<CompactionSweepResult> {
    const names = (deps.listWorkspaces ?? listWorkspaceNames)();
    const result: CompactionSweepResult = { attempted: [], succeeded: [], failed: {} };

    for (const name of names) {
        result.attempted.push(name);
        try {
            const store = await deps.resolver.getOrOpen(name);
            await (store as unknown as CompactableStore).compact();
            result.succeeded.push(name);
        } catch (err) {
            result.failed[name] = (err as Error).message;
            console.error(`[compaction-sweep] workspace "${name}" failed: ${(err as Error).message}`);
        }
    }
    return result;
}

export interface CompactionScheduler {
    timer: NodeJS.Timeout;
    /** Graceful stop — clears the interval and AWAITS any in-flight pass so
     *  a compact mid-LanceDB-optimize is never killed by process.exit.
     *  Idempotent. */
    stop(): Promise<void>;
}

/** Default cadence: once a day. Storage compaction is cheap to defer (unlike
 *  the 30-min consistency sweep) — LanceDB tolerates fragmentation for a
 *  while, and running the pass too often just spends IO for no benefit. */
const DEFAULT_COMPACT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function resolveCompactIntervalMs(): number {
    const raw = Number(process.env['LORE_COMPACT_INTERVAL_MS']);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMPACT_INTERVAL_MS;
}

/** Operator opt-out — set LORE_COMPACT_SCHEDULE_DISABLED=1 to disable the
 *  scheduled timer entirely (e.g. an operator who compacts externally via
 *  `lore compact` cron, or wants full control over the maintenance window). */
function scheduleDisabledByEnv(): boolean {
    return process.env['LORE_COMPACT_SCHEDULE_DISABLED'] === '1';
}

/**
 * Schedule a periodic storage-compaction pass. Returns a handle with the
 * cancellable timer plus an async `stop()` that drains any in-flight pass.
 * Wired in server.ts under `startsDaemonTimers` — LOCAL/daemon mode only;
 * embedded mode never calls this (host owns its own maintenance — see the
 * `maintain` MCP tool).
 *
 * Returns an inert (no live timer) handle when LORE_COMPACT_SCHEDULE_DISABLED=1,
 * matching the shape callers expect from every other scheduler in this file
 * family (retentionScheduler / scheduleConsistencySweep).
 */
export function scheduleCompactionSweep(
    run: () => Promise<CompactionSweepResult>,
    intervalMs: number = resolveCompactIntervalMs(),
): CompactionScheduler {
    if (scheduleDisabledByEnv()) {
        // Inert handle — no interval armed. `timer` must still be a valid
        // NodeJS.Timeout for callers that store it uniformly; use a
        // never-firing, already-unref'd timeout so it can't hold the
        // process open even if something forgets to call stop().
        const inert = setTimeout(() => {}, 0);
        clearTimeout(inert);
        return { timer: inert, async stop(): Promise<void> { /* nothing scheduled */ } };
    }

    let inflight: Promise<CompactionSweepResult> | null = null;

    const tick = (): void => {
        const p = run();
        inflight = p;
        p.then((result) => {
            if (Object.keys(result.failed).length > 0 || result.succeeded.length > 0) {
                console.error(
                    `[compaction-sweep] attempted=${result.attempted.length} ` +
                    `succeeded=${result.succeeded.length} failed=${Object.keys(result.failed).length}`,
                );
            }
        }).catch((err) => {
            console.error(`[compaction-sweep] pass failed: ${(err as Error).message}`);
        }).finally(() => {
            if (inflight === p) inflight = null;
        });
    };

    const timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
        timer,
        async stop(): Promise<void> {
            clearInterval(timer);
            if (inflight) await inflight.catch(() => { /* drained, errors already logged */ });
        },
    };
}
