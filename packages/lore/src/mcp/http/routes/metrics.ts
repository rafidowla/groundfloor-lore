/**
 * mcp/http/routes/metrics.ts — Sprint C1 /metrics endpoint.
 *
 *   GET /metrics — Prometheus text format when LORE_METRICS=on.
 *                   404 (not_enabled) when disabled (default for local).
 *
 * Metrics exposed:
 *   lore_outbox_depth{workspace}            — pending entries per workspace
 *   lore_outbox_lag_seconds{workspace}      — age of oldest pending entry
 *   lore_outbox_dead{workspace}             — entries past retry budget
 *   lore_outbox_depth_total                 — aggregate depth
 *   lore_outbox_lag_seconds_max             — worst lag across workspaces
 *   lore_load_jobs_total{state}             — Sprint Z load-jobs by state
 *   lore_embed_queue_depth                  — pending embed compute jobs
 *   lore_replicator_tick_total              — replicator ticks since boot
 *   lore_workspace_nodes{workspace}         — node count per workspace
 *   lore_workspace_edges{workspace}         — edge count per workspace
 *   lore_otel_enabled                       — 1 if a real OTel span processor is registered
 *   lore_otel_spans_started_total           — provision spans started
 *   lore_otel_spans_ended_total             — provision spans ended
 *   lore_build_info{version}                — daemon version
 *
 * Aggregation cache: /metrics is potentially scraped every 10–15s. To
 * avoid hammering the graph engine on every scrape, per-workspace counts are
 * cached for METRICS_CACHE_MS (5s). Outbox stats are read fresh (cheap
 * — file read of outbox.jsonl).
 *
 * Cloud activation: this endpoint stays unchanged; the cloud
 * scrape target wraps the same /metrics behind ingress auth.
 *
 * Sprint C-local: provision-only; concrete Prometheus scrape stack
 * deploys in cloud activation (Task #12).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import type { OutboxAggregateStats } from '../../../outbox/types.js';
import type { LoadJobsStore } from '../../../storage/loadJobsStore.js';
import { listWorkspaceNames } from '../../../config/workspaces.js';
import { getOtelReadiness } from '../../../observability/otelHooks.js';
import { VERSION } from '../../../version.js';
import { redactError } from '../../../security/logRedact.js';
import { writeError } from '../helpers.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import { canPrincipalReadWorkspace } from '../../../security/routeWorkspaceBinding.js';

const METRICS_CACHE_MS = 5000;
const BUILD_VERSION = VERSION;

export interface MetricsDeps {
    /** Sprint O1 — outbox aggregate stats. Same provider /api/health uses. */
    getOutboxStats?: () => Promise<OutboxAggregateStats>;
    /** Per-workspace LocalGraph registry (workspace counts). */
    graphRegistry?: LocalGraphRegistry;
    /** Sprint Z1 — load-jobs SQLite store (state counts). */
    loadJobsStore?: LoadJobsStore;
    /** Architecture gap #2 — embed queue depth. Optional. */
    embedQueue?: { depth?: () => number };
    /** Replicator tick counter. Optional; defaults to 0. */
    getReplicatorTicks?: () => number;
}

interface CachedWorkspaceCounts {
    fetchedAt: number;
    counts: Record<string, { nodeCount: number; edgeCount: number }>;
}

let countsCache: CachedWorkspaceCounts | null = null;

/** Test-only — reset the in-process aggregation cache. */
export function _resetMetricsCache(): void {
    countsCache = null;
}

function metricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.LORE_METRICS?.trim().toLowerCase();
    return raw === 'on' || raw === '1' || raw === 'true';
}

/** Escape Prometheus label value per spec. */
function escapeLabel(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function fmtLine(name: string, labels: Record<string, string> | null, value: number): string {
    if (!labels || Object.keys(labels).length === 0) return `${name} ${value}`;
    const lbls = Object.entries(labels)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(',');
    return `${name}{${lbls}} ${value}`;
}

async function readWorkspaceCounts(graphRegistry: LocalGraphRegistry | undefined): Promise<Record<string, { nodeCount: number; edgeCount: number }>> {
    if (!graphRegistry) return {};
    const now = Date.now();
    if (!countsCache || (now - countsCache.fetchedAt) >= METRICS_CACHE_MS) {
        // Compute UNFILTERED counts for every workspace — but (3.3) NEVER open
        // a graph here: only read counts from a workspace whose handle is
        // already open (the SP-11 idle LRU exists to keep native memory
        // bounded, and a scrape must not defeat it). Not-yet-open → 0.
        const counts: Record<string, { nodeCount: number; edgeCount: number }> = {};
        try {
            for (const name of listWorkspaceNames()) {
                const g = graphRegistry.getOpenGraphHandle(name);
                if (!g) { counts[name] = { nodeCount: 0, edgeCount: 0 }; continue; }
                try {
                    const getStats = g.getStats as (p?: string) => Promise<{ nodeCount?: number; edgeCount?: number }>;
                    const s = await getStats(name);
                    counts[name] = { nodeCount: s.nodeCount ?? 0, edgeCount: s.edgeCount ?? 0 };
                } catch {
                    counts[name] = { nodeCount: 0, edgeCount: 0 };
                }
            }
        } catch {
            // Registry/listing failed — return whatever we got.
        }
        countsCache = { fetchedAt: now, counts };
    }
    // 3.4 (2026-08-17) — apply the principal read filter AFTER the cache, on
    // every call, so the shared 5s cache is never poisoned by one principal's
    // filtered view (which would leak A's workspaces to B or hide B's own).
    // A null principal (legacy/local) sees the full list unchanged.
    const principal = getCurrentPrincipal();
    if (!principal) return countsCache.counts;
    const filtered: Record<string, { nodeCount: number; edgeCount: number }> = {};
    for (const [name, c] of Object.entries(countsCache.counts)) {
        if (canPrincipalReadWorkspace(principal, name)) filtered[name] = c;
    }
    return filtered;
}

async function readLoadJobCounts(store: LoadJobsStore | undefined): Promise<Record<string, number>> {
    if (!store) return {};
    try {
        const stats = (store as unknown as { aggregateStats?: () => Promise<Record<string, number>> }).aggregateStats;
        if (typeof stats === 'function') {
            return await stats.call(store);
        }
    } catch {
        // Fall through.
    }
    return {};
}

/** Build the Prometheus exposition payload. Exported for unit tests. */
export async function renderMetrics(deps: MetricsDeps): Promise<string> {
    const lines: string[] = [];

    // ── build_info ─────────────────────────────────────────────
    lines.push('# HELP lore_build_info Daemon build metadata');
    lines.push('# TYPE lore_build_info gauge');
    lines.push(fmtLine('lore_build_info', { version: BUILD_VERSION }, 1));

    // ── outbox ─────────────────────────────────────────────────
    lines.push('# HELP lore_outbox_depth Pending outbox entries per workspace');
    lines.push('# TYPE lore_outbox_depth gauge');
    lines.push('# HELP lore_outbox_lag_seconds Age of oldest pending outbox entry per workspace');
    lines.push('# TYPE lore_outbox_lag_seconds gauge');
    lines.push('# HELP lore_outbox_dead Outbox entries past retry budget per workspace');
    lines.push('# TYPE lore_outbox_dead gauge');

    let aggregateDepth = 0;
    let maxLag = 0;
    if (deps.getOutboxStats) {
        try {
            const stats = await deps.getOutboxStats();
            aggregateDepth = stats.depth;
            maxLag = stats.lagSeconds;
            for (const [ws, s] of Object.entries(stats.perWorkspace)) {
                lines.push(fmtLine('lore_outbox_depth', { workspace: ws }, s.depth));
                lines.push(fmtLine('lore_outbox_lag_seconds', { workspace: ws }, s.lagSeconds));
                lines.push(fmtLine('lore_outbox_dead', { workspace: ws }, s.dead));
            }
        } catch {
            // outbox stats provider failed — emit zeros (better than no scrape).
        }
    }
    lines.push('# HELP lore_outbox_depth_total Aggregate pending outbox depth across all workspaces');
    lines.push('# TYPE lore_outbox_depth_total gauge');
    lines.push(fmtLine('lore_outbox_depth_total', null, aggregateDepth));
    lines.push('# HELP lore_outbox_lag_seconds_max Worst lagSeconds across workspaces');
    lines.push('# TYPE lore_outbox_lag_seconds_max gauge');
    lines.push(fmtLine('lore_outbox_lag_seconds_max', null, maxLag));

    // ── workspace counts ───────────────────────────────────────
    const wsCounts = await readWorkspaceCounts(deps.graphRegistry);
    lines.push('# HELP lore_workspace_nodes Node count per workspace');
    lines.push('# TYPE lore_workspace_nodes gauge');
    lines.push('# HELP lore_workspace_edges Edge count per workspace');
    lines.push('# TYPE lore_workspace_edges gauge');
    for (const [ws, c] of Object.entries(wsCounts)) {
        lines.push(fmtLine('lore_workspace_nodes', { workspace: ws }, c.nodeCount));
        lines.push(fmtLine('lore_workspace_edges', { workspace: ws }, c.edgeCount));
    }

    // ── load jobs ──────────────────────────────────────────────
    const loadJobs = await readLoadJobCounts(deps.loadJobsStore);
    lines.push('# HELP lore_load_jobs_total Load jobs by state (Sprint Z)');
    lines.push('# TYPE lore_load_jobs_total gauge');
    for (const [state, count] of Object.entries(loadJobs)) {
        lines.push(fmtLine('lore_load_jobs_total', { state }, count));
    }

    // ── embed queue ────────────────────────────────────────────
    let embedDepth = 0;
    if (deps.embedQueue?.depth) {
        try { embedDepth = deps.embedQueue.depth(); } catch { /* ignore */ }
    }
    lines.push('# HELP lore_embed_queue_depth Pending embedding compute jobs');
    lines.push('# TYPE lore_embed_queue_depth gauge');
    lines.push(fmtLine('lore_embed_queue_depth', null, embedDepth));

    // ── replicator ─────────────────────────────────────────────
    const replicatorTicks = deps.getReplicatorTicks ? deps.getReplicatorTicks() : 0;
    lines.push('# HELP lore_replicator_tick_total Replicator ticks since daemon boot');
    lines.push('# TYPE lore_replicator_tick_total counter');
    lines.push(fmtLine('lore_replicator_tick_total', null, replicatorTicks));

    // ── OTel readiness ─────────────────────────────────────────
    // lore_otel_enabled is 1 only when a real span processor has been
    // registered via registerSpanProcessor(). Setting the env var alone
    // is insufficient — otelHooks.ts is a stub until the SDK is wired.
    const otel = getOtelReadiness();
    lines.push('# HELP lore_otel_enabled 1 when a real OTel span processor is registered (not merely env-configured)');
    lines.push('# TYPE lore_otel_enabled gauge');
    lines.push(fmtLine('lore_otel_enabled', null, otel.enabled ? 1 : 0));
    lines.push('# HELP lore_otel_spans_started_total OTel provision spans started');
    lines.push('# TYPE lore_otel_spans_started_total counter');
    lines.push(fmtLine('lore_otel_spans_started_total', null, otel.spansStarted));
    lines.push('# HELP lore_otel_spans_ended_total OTel provision spans ended');
    lines.push('# TYPE lore_otel_spans_ended_total counter');
    lines.push(fmtLine('lore_otel_spans_ended_total', null, otel.spansEnded));

    return lines.join('\n') + '\n';
}

/**
 * tryMetricsRoutes — Match /metrics or return false.
 *
 * Gated on LORE_METRICS env to keep the scrape surface invisible to
 * accidental discovery on local installs. Operators flip the flag
 * when they have a Prometheus stack pointed at the daemon.
 */
export async function tryMetricsRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: MetricsDeps,
): Promise<boolean> {
    if (pathname !== '/metrics' || req.method !== 'GET') return false;

    if (!metricsEnabled()) {
        writeError(res, 404, 'metrics_not_enabled', 'metrics endpoint is disabled', {
            hint: 'set LORE_METRICS=on in the daemon environment to enable /metrics',
        });
        return true;
    }

    try {
        const body = await renderMetrics(deps);
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
    return true;
}
