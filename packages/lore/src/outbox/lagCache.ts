/**
 * outbox/lagCache.ts — Sprint O4 per-workspace lag cache.
 *
 * The backpressure gate (writeOutboxBackpressure helper, wired into
 * every hot + bulk write endpoint) needs sub-millisecond access to the
 * "is workspace X over its lag threshold?" decision. A per-request
 * SQL aggregate against outbox.sqlite would add a query on the hot
 * path; instead the replicator refreshes this cache once per tick
 * (default ~250ms idle / 10ms busy) and routes read it via cheap map
 * lookup.
 *
 * Sub-millisecond contract:
 *   - get(workspace) is a Map.get → struct read → comparison. No I/O,
 *     no allocation in the happy path.
 *   - shouldBackpressure(...) is the same plus two numeric comparisons.
 *
 * Fail-open contract:
 *   - When the cache has no entry for a workspace (cold start, brand
 *     new workspace), shouldBackpressure() returns null — meaning "we
 *     don't know yet, let the write through". The spec is explicit:
 *     don't block writes during a cache miss. A warning is logged once
 *     per workspace per process via the bookkeeping inside refresh().
 *
 * Per-workspace overrides:
 *   - The constructor accepts a thresholdResolver(workspace) → number
 *     callback that the daemon wires to the workspaces.json
 *     `outboxLagThresholdSeconds` field with the global default as the
 *     fallback. The cache itself stays vocab-free about WHERE the
 *     override comes from — that's the wiring layer's job.
 */

import type { OutboxAggregateStats } from './types.js';

export interface LagCacheSnapshot {
    /** Seconds since the oldest pending entry's createdAt. 0 when depth=0. */
    lagSeconds: number;
    /** Count of entries with status in {pending, replicating, failed}. */
    depth: number;
    /** ms since epoch when refresh() last populated this entry. */
    refreshedAt: number;
}

export interface BackpressureDecision {
    /** True when the caller should issue 503. */
    shouldBlock: boolean;
    /** Current cached lag in seconds (0 if cache miss). */
    currentLagSeconds: number;
    /** Threshold that was checked (per-workspace override or global default). */
    thresholdSeconds: number;
    /** Outbox depth at last refresh. */
    outboxDepth: number;
    /** Depth threshold used in the decision. */
    depthThreshold: number;
    /** True when the cache had no entry — caller logs once + lets write through. */
    cacheMiss: boolean;
}

export interface LagCacheConfig {
    /** Global lag threshold in seconds. Per-workspace override (when set)
     *  takes precedence. Default 30 (env: LORE_OUTBOX_LAG_THRESHOLD_SECONDS). */
    defaultLagThresholdSeconds: number;
    /** Global depth threshold. Default 10000 (env: LORE_OUTBOX_DEPTH_THRESHOLD). */
    depthThreshold: number;
    /** Resolves the lag threshold for a workspace. Wiring layer reads
     *  the per-workspace `outboxLagThresholdSeconds` field from
     *  workspaces.json and falls back to defaultLagThresholdSeconds when
     *  unset. Default: returns defaultLagThresholdSeconds. */
    thresholdResolver?: (workspace: string) => number;
    /** Optional logger for the cache-miss warning. Defaults to no-op. */
    log?: (msg: string) => void;
}

export const DEFAULT_LAG_THRESHOLD_SECONDS = 30;
export const DEFAULT_DEPTH_THRESHOLD = 10000;

/** Read env defaults at construction time. Exposed so wiring + tests
 *  can compose the same config. */
export function readEnvLagCacheConfig(): Pick<LagCacheConfig, 'defaultLagThresholdSeconds' | 'depthThreshold'> {
    const lagEnv = Number(process.env.LORE_OUTBOX_LAG_THRESHOLD_SECONDS);
    const depthEnv = Number(process.env.LORE_OUTBOX_DEPTH_THRESHOLD);
    return {
        defaultLagThresholdSeconds: Number.isFinite(lagEnv) && lagEnv > 0
            ? lagEnv
            : DEFAULT_LAG_THRESHOLD_SECONDS,
        depthThreshold: Number.isFinite(depthEnv) && depthEnv > 0
            ? depthEnv
            : DEFAULT_DEPTH_THRESHOLD,
    };
}

/**
 * OutboxLagCache — in-process snapshot of per-workspace outbox lag,
 * refreshed by the replicator each tick. Routes call
 * `shouldBackpressure(workspace)` synchronously on the hot path.
 */
export class OutboxLagCache {
    private readonly snapshots = new Map<string, LagCacheSnapshot>();
    private readonly warnedMiss = new Set<string>();
    private lastRefreshAt = 0;
    private readonly cfg: Required<Omit<LagCacheConfig, 'log'>> & { log: (msg: string) => void };

    constructor(cfg: LagCacheConfig) {
        this.cfg = {
            defaultLagThresholdSeconds: cfg.defaultLagThresholdSeconds,
            depthThreshold: cfg.depthThreshold,
            thresholdResolver: cfg.thresholdResolver
                ?? ((_ws: string) => cfg.defaultLagThresholdSeconds),
            log: cfg.log ?? ((_: string) => undefined),
        };
    }

    /** Wholesale replace the per-workspace snapshot from an aggregate
     *  stats block (typically `outboxStore.aggregateStats()`). Called
     *  by the replicator at the end of each tick. */
    refresh(stats: OutboxAggregateStats): void {
        const now = Date.now();
        // Replace, not merge: workspaces with depth=0 should still get a
        // fresh row so backpressure clears as soon as a drain completes.
        this.snapshots.clear();
        // SP-11 — clear the once-per-process miss-warning set on every
        // wholesale refresh. shouldBackpressure() already self-clears an
        // entry on the next hit (line ~152), so this is belt-and-braces:
        // it bounds the Set to at most one refresh-window's worth of
        // never-seen workspaces and lets a workspace that disappears +
        // reappears across a gap re-log the miss for operator visibility.
        this.warnedMiss.clear();
        for (const [ws, s] of Object.entries(stats.perWorkspace)) {
            this.snapshots.set(ws, {
                lagSeconds: s.lagSeconds,
                depth: s.depth,
                refreshedAt: now,
            });
        }
        this.lastRefreshAt = now;
    }

    /** Synchronous decision used by the hot/bulk request handlers. */
    shouldBackpressure(workspace: string): BackpressureDecision {
        const threshold = this.cfg.thresholdResolver(workspace);
        const snap = this.snapshots.get(workspace);
        if (!snap) {
            // Fail-open per spec. Log once per workspace.
            if (!this.warnedMiss.has(workspace)) {
                this.warnedMiss.add(workspace);
                this.cfg.log(`[outbox lag-cache] miss for workspace='${workspace}'; failing open`);
            }
            return {
                shouldBlock: false,
                currentLagSeconds: 0,
                thresholdSeconds: threshold,
                outboxDepth: 0,
                depthThreshold: this.cfg.depthThreshold,
                cacheMiss: true,
            };
        }
        // Clear the once-per-process miss warning so a workspace that
        // disappears + reappears (rare; e.g. registry alias rebind) can
        // re-warn instead of silently failing-open forever.
        if (this.warnedMiss.has(workspace)) this.warnedMiss.delete(workspace);
        const lagOver = snap.lagSeconds > threshold;
        const depthOver = snap.depth > this.cfg.depthThreshold;
        return {
            shouldBlock: lagOver || depthOver,
            currentLagSeconds: snap.lagSeconds,
            thresholdSeconds: threshold,
            outboxDepth: snap.depth,
            depthThreshold: this.cfg.depthThreshold,
            cacheMiss: false,
        };
    }

    /** Per-workspace snapshot read — exposed for /api/health
     *  `perWorkspaceOutbox` rendering (gate test O-D9). */
    snapshot(workspace: string): LagCacheSnapshot | undefined {
        return this.snapshots.get(workspace);
    }

    /** Full snapshot map — used by /api/health and by the unit test
     *  suite for observability. */
    allSnapshots(): Record<string, LagCacheSnapshot> {
        const out: Record<string, LagCacheSnapshot> = {};
        for (const [k, v] of this.snapshots.entries()) out[k] = { ...v };
        return out;
    }

    /** ms-since-epoch of the last refresh; 0 if never refreshed. */
    getLastRefreshAt(): number {
        return this.lastRefreshAt;
    }

    /** Test-only injection — directly set a workspace's snapshot.
     *  Production code paths must NEVER call this; the replicator's
     *  `refresh()` is the only legitimate writer. */
    testInject(workspace: string, lagSeconds: number, depth: number): void {
        this.snapshots.set(workspace, {
            lagSeconds,
            depth,
            refreshedAt: Date.now(),
        });
        // Drop any prior "miss" warning state so the test sees a clean
        // hit path.
        this.warnedMiss.delete(workspace);
    }

    /** Test-only — clear a workspace's snapshot. */
    testClear(workspace?: string): void {
        if (workspace === undefined) {
            this.snapshots.clear();
            this.warnedMiss.clear();
            return;
        }
        this.snapshots.delete(workspace);
    }

    /** Configuration accessors used by the wiring layer + tests. */
    getDefaultThreshold(): number { return this.cfg.defaultLagThresholdSeconds; }
    getDepthThreshold(): number { return this.cfg.depthThreshold; }
}
