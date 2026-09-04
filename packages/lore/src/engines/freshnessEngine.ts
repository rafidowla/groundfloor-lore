/**
 * packages/lore/src/engines/freshnessEngine.ts
 *
 * Computes data-freshness reports for a workspace by inspecting the
 * `syncedAt` timestamp on every node. Read-only — no writes are made
 * to the graph. Staleness is a read-time computation so nothing in
 * the graph is corrupted by the sweep.
 *
 * Design rationale:
 *   The `stale` flag on LoreNode signals sync-divergence (a local
 *   write that hasn't reached the remote yet). Freshness is orthogonal:
 *   it asks "when was this node last confirmed from any source?"
 *   The two concerns are kept separate to avoid conflating write-status
 *   with read-time TTL semantics.
 *
 * Local-only freshness:
 *   Nodes auto-ingested from LORE_WATCH_PATHS never have a `syncedAt`
 *   timestamp (they've never been synced to a remote). Without special
 *   handling, a workspace that only uses local files would report 100%
 *   "neverSynced" — which is confusing.
 *
 *   Resolution: when `syncedAt` is absent, `updatedAt` is used as a
 *   fallback freshness signal. A node updated within the TTL window is
 *   counted as fresh even if it has never been synced. Nodes with both
 *   `syncedAt` and `updatedAt` beyond the TTL (or genuinely old local
 *   nodes) still land in `neverSyncedNodes`.
 *
 * Env var:
 *   LORE_FRESHNESS_TTL_HOURS (default 24). Any node whose effective
 *   freshness timestamp (syncedAt, or updatedAt as fallback) is older
 *   than this threshold is reported as stale-by-age or neverSynced.
 *
 * Usage:
 *   // in a route handler or the sync engine
 *   const report = await sweepFreshness(graph, 'my-workspace');
 *   console.log(`${report.freshnessPercent}% fresh`);
 *
 * Cloud-portability:
 *   IFreshnessGraph is satisfied by both LocalGraph and DataplaneGraph.
 *   No engine-specific API is used here.
 */

import type { LoreNode } from '../providers/types.js';
import { forEachNodePage, type NodePager } from './nodePager.js';

const DEFAULT_TTL_HOURS = 24;
const HOUR_MS = 3_600_000;

/* ─── Public Types ────────────────────────────────────────────────── */

/**
 * Minimal graph interface required by sweepFreshness.
 * Satisfied by LocalGraph, DataplaneGraph, and test fakes.
 */
export interface IFreshnessGraph {
    listNodes(
        type?: string,
        tag?: string,
        project?: string,
        ecosystem?: string,
        limit?: number,
        opts?: { unbounded?: boolean },
    ): Promise<LoreNode[]>;
    /**
     * P1 scale fix — optional keyset-pagination surface. When present (real
     * LocalGraph/SurrealGraph), sweepFreshness folds the report one bounded
     * PAGE at a time, projecting only syncedAt + updatedAt instead of
     * materializing every node's full content. Absent on fakes/DataplaneGraph
     * → unbounded fallback.
     *
     * 2026-08-21: this used to be `getGraphContext?()`, i.e. a raw Cypher
     * runner, which made the bounded walk single-engine-only — a Surreal-backed
     * workspace silently took the unbounded fallback. `bulkListProjected` is
     * the same walk as an engine-agnostic operation; both engines implement it
     * (same swap diagnostics/consistency.ts made on 2026-08-06).
     */
    bulkListProjected?: NodePager;
}

/** Report returned by sweepFreshness and computeFreshness. */
export interface FreshnessReport {
    /** Workspace name or path used as identifier (informational). */
    workspace: string;
    /** TTL threshold used for this report, in hours. */
    ttlHours: number;
    /** Total nodes inspected. */
    totalNodes: number;
    /** Nodes with syncedAt within the TTL window — considered fresh. */
    freshNodes: number;
    /** Nodes with syncedAt older than ttlHours — considered stale. */
    staleNodes: number;
    /** Nodes that have never been synced (syncedAt is empty/null). */
    neverSyncedNodes: number;
    /**
     * freshNodes / (totalNodes − neverSyncedNodes) × 100.
     * Returns 100 when no nodes have ever been synced (can't penalise
     * a workspace that isn't configured for sync).
     */
    freshnessPercent: number;
    /** ISO 8601 of the oldest syncedAt among synced nodes, or null. */
    oldestSyncedAt: string | null;
    /** ISO 8601 of the most recent syncedAt among synced nodes, or null. */
    newestSyncedAt: string | null;
    /**
     * IDs of nodes whose syncedAt exceeds the TTL (capped at 100 to
     * keep response payloads bounded).
     */
    staleNodeIds: string[];
    /** ISO 8601 timestamp when this report was generated. */
    generatedAt: string;
}

/* ─── Helpers ─────────────────────────────────────────────────────── */

/**
 * readFreshnessTtl — Resolve the TTL to use.
 * Priority: explicit override → LORE_FRESHNESS_TTL_HOURS env var → 24 h.
 */
export function readFreshnessTtl(overrideHours?: number): number {
    if (typeof overrideHours === 'number' && Number.isFinite(overrideHours) && overrideHours > 0) {
        return overrideHours;
    }
    const env = Number(process.env.LORE_FRESHNESS_TTL_HOURS);
    return Number.isFinite(env) && env > 0 ? env : DEFAULT_TTL_HOURS;
}

/* ─── Core Functions ──────────────────────────────────────────────── */

/**
 * FreshnessAccumulator — streaming folder shared by the array-based
 * `computeFreshness` and the keyset-paged `sweepFreshness`. Holding only the
 * running counters (not the node list) is what lets the paged path bound peak
 * heap to a single page. `add()` must receive the same per-node fields
 * (`id`, `syncedAt`, `updatedAt`) in the SAME order the old single-pass loop
 * saw them, so the resulting report is identical.
 */
class FreshnessAccumulator {
    private readonly thresholdMs: number;
    readonly staleNodeIds: string[] = [];
    freshCount = 0;
    neverCount = 0;
    total = 0;
    oldestTs: number | null = null;
    newestTs: number | null = null;

    constructor(private readonly nowMs: number, ttlHours: number) {
        this.thresholdMs = ttlHours * HOUR_MS;
    }

    add(node: { id: string; syncedAt?: string | null; updatedAt?: string | null }): void {
        this.total++;
        const rawSynced = node.syncedAt;
        if (rawSynced) {
            // Primary path: node has been synced — classify by syncedAt age.
            const ts = Date.parse(rawSynced as string);
            if (!Number.isFinite(ts)) {
                // Malformed timestamp — treat as never-synced.
                this.neverCount++;
                return;
            }
            if (this.oldestTs === null || ts < this.oldestTs) this.oldestTs = ts;
            if (this.newestTs === null || ts > this.newestTs) this.newestTs = ts;
            if (this.nowMs - ts > this.thresholdMs) {
                if (this.staleNodeIds.length < 100) this.staleNodeIds.push(node.id);
            } else {
                this.freshCount++;
            }
        } else {
            // No syncedAt — check updatedAt as a local-freshness fallback.
            // A node written (or auto-ingested) within the TTL window is
            // fresh even if it has never been synced to a remote.
            const rawUpdated = node.updatedAt;
            const updTs = rawUpdated ? Date.parse(rawUpdated) : NaN;
            if (Number.isFinite(updTs) && this.nowMs - updTs <= this.thresholdMs) {
                this.freshCount++;
            } else {
                this.neverCount++;
            }
        }
    }

    finalize(workspace: string, ttlHours: number): FreshnessReport {
        const syncedCount = this.total - this.neverCount;
        const staleCount = syncedCount - this.freshCount;
        const freshnessPercent = syncedCount === 0
            ? 100
            : Math.round((this.freshCount / syncedCount) * 100);
        return {
            workspace,
            ttlHours,
            totalNodes: this.total,
            freshNodes: this.freshCount,
            staleNodes: staleCount,
            neverSyncedNodes: this.neverCount,
            freshnessPercent,
            oldestSyncedAt: this.oldestTs !== null ? new Date(this.oldestTs).toISOString() : null,
            newestSyncedAt: this.newestTs !== null ? new Date(this.newestTs).toISOString() : null,
            staleNodeIds: this.staleNodeIds,
            generatedAt: new Date(this.nowMs).toISOString(),
        };
    }
}

/**
 * computeFreshness — Pure function. Accepts a pre-fetched node array
 * and returns a FreshnessReport. Useful for unit tests and batch callers
 * that already hold the node list.
 *
 * @param nodes     - Full node list for the workspace.
 * @param workspace - Workspace label (informational, included in report).
 * @param ttlHours  - Staleness threshold in hours.
 * @param nowMs     - Override "now" epoch ms for deterministic tests.
 */
export function computeFreshness(
    nodes: LoreNode[],
    workspace: string,
    ttlHours: number,
    nowMs: number = Date.now(),
): FreshnessReport {
    const acc = new FreshnessAccumulator(nowMs, ttlHours);
    for (const node of nodes) acc.add(node);
    return acc.finalize(workspace, ttlHours);
}

/**
 * sweepFreshness — Fetch all nodes from the graph and compute a
 * FreshnessReport. Non-destructive: no writes are made to the graph.
 *
 * @param graph     - Graph implementing IFreshnessGraph (local or cloud).
 * @param workspace - Workspace label for the report (informational).
 * @param ttlHours  - Staleness threshold; omit to use LORE_FRESHNESS_TTL_HOURS.
 * @param nowMs     - Override "now" epoch ms for deterministic tests.
 */
export async function sweepFreshness(
    graph: IFreshnessGraph,
    workspace: string,
    ttlHours?: number,
    nowMs?: number,
): Promise<FreshnessReport> {
    const ttl = readFreshnessTtl(ttlHours);
    const now = nowMs ?? Date.now();
    const acc = new FreshnessAccumulator(now, ttl);
    // P1 scale fix — page the walk projecting only syncedAt + updatedAt (no
    // content), folding each bounded page into the accumulator. Peak heap is
    // one page. Fakes/DataplaneGraph without bulkListProjected fall back to
    // the unbounded listNodes scan (small / non-local paths).
    const pager = graph.bulkListProjected?.bind(graph);
    if (pager) {
        await forEachNodePage(
            pager, '*', ['syncedAt'], (rows) => {
            for (const r of rows) {
                acc.add({
                    id: String(r['id'] ?? ''),
                    syncedAt: (r['syncedAt'] as string | null) ?? null,
                    updatedAt: (r['updatedAt'] as string | null) ?? null,
                });
            }
        });
        return acc.finalize(workspace, ttl);
    }
    const nodes = await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
    for (const node of nodes) acc.add(node);
    return acc.finalize(workspace, ttl);
}
