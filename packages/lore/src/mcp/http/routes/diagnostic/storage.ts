/**
 * storage.ts — disk/usage + report + hardware + cache-stats routes.
 *
 *   GET    /api/report               — markdown digest of the active graph
 *   GET    /api/storage              — per-workspace disk + quota state
 *   GET    /api/diagnostic/hardware  — hardware probe + tier recommendation
 *   GET/DELETE /api/diagnostic/cache-stats — read/reset cache counters
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeGraphReport } from '../../../../engines/graphReport.js';
import type { ReportGraph } from '../../../../engines/graphReportAggregates.js';
import { inspectAllWorkspaces, inspectDataHome } from '../../../../engines/storageInspector.js';
import { getCurrentPrincipal } from '../../../../auth/principal.js';
import { bindRouteTarget, authorizeExtraTarget, canPrincipalReadWorkspace } from '../../../../security/routeWorkspaceBinding.js';
import { WorkspaceNotFoundError } from '../../../../engines/localGraphRegistry.js';
import type { LoreGraph } from './shared.js';
import { decideQuota } from '../../../../engines/quotaManager.js';
import { loreHome } from '../../../../config/loreHome.js';
import { probeFullCapabilities } from '../../../../engines/extractors/qualityAdvisor.js';
import { LATENCY_BUCKETS_MS, type CacheStats } from '../../../../engines/cache.js';
import type { DiagnosticDeps } from './shared.js';
import { redactError } from '../../../../security/logRedact.js';
import { writeError } from '../../helpers.js';

/**
 * Can this graph serve `writeGraphReport`?
 *
 * The report is four aggregations over paged node/edge scans. The local
 * engine implements that surface; `DataplaneGraph` does not. Detecting the
 * CAPABILITY rather than the class is what lets a Surreal-backed workspace
 * through without a hardcoded class check.
 */
function supportsGraphReport(g: LoreGraph): g is LoreGraph & ReportGraph {
    const c = g as Partial<ReportGraph>;
    return typeof c.bulkListProjected === 'function' && typeof c.queryEdges === 'function';
}

export async function handleReport(res: ServerResponse, url: string, deps: DiagnosticDeps): Promise<void> {
    try {
        const parsed = new URL(url, 'http://localhost');
        const project = parsed.searchParams.get('project') ?? undefined;
        const topN = parseInt(parsed.searchParams.get('topN') ?? '20', 10);
        // R4 #6 — the report dumps node ids+labels+types. It previously read the
        // boot graph unconditionally, so a token scoped to workspace B got the
        // BOOT workspace's report (cross-workspace disclosure). Gate + route per
        // workspace: target = ?workspace=<name> or the principal's own
        // workspace; refuse a foreign target and read THAT workspace's graph.
        // Null principal (legacy/local) keeps the boot-graph behavior.
        const reportPrincipal = getCurrentPrincipal();
        const queryWs = parsed.searchParams.get('workspace') ?? undefined;
        const requestedWs = queryWs ?? reportPrincipal?.workspace ?? null;
        if (reportPrincipal && requestedWs) {
            if (bindRouteTarget(res, { requested: requestedWs, intent: 'read' }) === null) return;
        }
        let reportGraph: LoreGraph = deps.store.loreGraph as LoreGraph;
        if (deps.graphRegistry && requestedWs) {
            try {
                reportGraph = await deps.graphRegistry.getGraphHandle(requestedWs);
            } catch (err) {
                if (err instanceof WorkspaceNotFoundError) {
                    writeError(res, 404, 'workspace_not_found', `workspace "${err.requested}" not found`, { requested: err.requested, known: err.known });
                    return;
                }
                throw err;
            }
        }
        // Q2.2 — this used to be a comment promising a cloud-mode follow-up
        // while the call went through regardless and died on a TypeError deep
        // inside the aggregation. Refuse with the 501 shape instead: a named
        // refusal beats a stack trace.
        if (!supportsGraphReport(reportGraph)) {
            writeError(res, 501, 'cloud_mode_unsupported',
                'graph report is unavailable in cloud mode: it needs the paged node/edge scan surface (bulkListProjected + queryEdges), which DataplaneGraph does not implement.',
                { operation: 'graph_report' });
            return;
        }
        const md = await writeGraphReport(reportGraph, {
            project,
            topN: Number.isFinite(topN) ? topN : 20,
        });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(md);
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}

export function handleStorage(res: ServerResponse): void {
    try {
        const dataHome = loreHome();
        let workspaces = inspectAllWorkspaces(dataHome);
        // R4 #7 — this enumerates EVERY workspace's name + absolute disk path +
        // usage. Filter to the workspaces the principal may read so a scoped app
        // token can't enumerate other tenants. A principal with
        // cross-workspace-read (master/shared-secret) passes every entry; a
        // null principal (legacy/local) sees the full list unchanged.
        const principal = getCurrentPrincipal();
        if (principal) {
            // R4 #7 — filter to the workspaces the principal may read, then
            // authorize each survivor as an extra target so the chokepoint
            // admits opening it below — this route enumerates every
            // workspace's own on-disk breakdown, not just the bound one.
            // This is the enumeration escape lane the Wave 4.1 spec defines:
            // per-item requireReadFromWorkspace filter + authorizeExtraTarget
            // for each pass (routeWorkspaceBinding.ts owns the raw gate call
            // so route files stay off the banned-import list).
            workspaces = workspaces.filter((w) => canPrincipalReadWorkspace(principal, w.name));
            for (const w of workspaces) authorizeExtraTarget(w.name);
        }
        const home = inspectDataHome(dataHome);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            dataHome: {
                path: dataHome,
                breakdown: home,
            },
            workspaces: workspaces.map((w) => ({
                name: w.name,
                path: w.path,
                breakdown: w.breakdown,
                quota: decideQuota({ breakdown: w.breakdown }),
            })),
        }));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}

export async function handleHardware(res: ServerResponse, deps: DiagnosticDeps): Promise<void> {
    try {
        const os = await import('node:os');
        const caps = await probeFullCapabilities();
        const totalRamGb = caps.system.totalRamGB;
        const platform = caps.system.platform;
        const arch = caps.system.arch;

        // Disk free — best-effort; stat the home dir partition.
        let diskFreeGb = 0;
        try {
            const { execFileSync } = await import('node:child_process');
            const dfOut = execFileSync('df', ['-k', os.homedir()], { stdio: 'pipe' }).toString();
            const line = dfOut.split('\n')[1];
            if (line) {
                const fields = line.trim().split(/\s+/);
                diskFreeGb = Math.round(parseInt(fields[3] ?? '0', 10) / 1024 / 1024);
            }
        } catch { /* ignore */ }

        // OS-native inference: Apple Silicon (arm64 mac) with ≥8 GB.
        const osNativeAi = platform === 'darwin' && arch === 'arm64' && totalRamGb >= 8;

        // Tier recommendation heuristic:
        //   powerful  → ≥16 GB AND (Ollama text model present OR OS-native AI)
        //   standard  → ≥8 GB
        //   basic     → ≥4 GB
        //   lite      → fallback (no LLM needed)
        const ollamaTextModel = caps.tier2.ollama.textModel;
        type AiTier = 'lite' | 'basic' | 'standard' | 'powerful' | 'hybrid';
        let recommendedTier: AiTier;
        if (totalRamGb >= 16 && (ollamaTextModel || osNativeAi)) {
            recommendedTier = 'powerful';
        } else if (totalRamGb >= 8) {
            recommendedTier = 'standard';
        } else if (totalRamGb >= 4) {
            recommendedTier = 'basic';
        } else {
            recommendedTier = 'lite';
        }

        const cfg = deps.configManager.read();
        const configuredTier: AiTier = (cfg.aiTier ?? 'lite') as AiTier;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ramGb: totalRamGb,
            diskFreeGb,
            os: platform,
            arch,
            osNativeAi,
            ollamaReachable: caps.tier2.ollama.reachable,
            ollamaTextModel: ollamaTextModel ?? null,
            recommendedTier,
            configuredTier,
        }));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}

export async function handleCacheStats(req: IncomingMessage, res: ServerResponse, deps: DiagnosticDeps): Promise<void> {
    try {
        const graph = deps.store.loreGraph as { getCacheStats?: () => unknown; resetCacheStats?: () => void };
        if (typeof graph.getCacheStats !== 'function') {
            writeError(res, 501, 'cache_stats_unavailable', 'cache stats not available in this deployment mode');
            return;
        }
        if (req.method === 'DELETE') {
            graph.resetCacheStats?.();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ reset: true }));
            return;
        }
        if (req.method === 'GET') {
            const raw = graph.getCacheStats() as CacheStats;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(decorateCacheStats(raw)));
            return;
        }
        writeError(res, 405, 'method_not_allowed', 'method not allowed');
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}

/**
 * Compute hit-rate + p50/p95/p99 (approximated from the bucketed histogram)
 * per kind, plus an aggregate hit-rate. Adds derived fields without
 * mutating the raw counters. (Added 2026-05-14.)
 */
function decorateCacheStats(raw: CacheStats): Record<string, unknown> {
    function pct(counts: number[], n: number, p: number): number | null {
        if (n === 0) return null;
        const target = Math.ceil(n * p);
        let cumulative = 0;
        for (let i = 0; i < counts.length; i++) {
            cumulative += counts[i]!;
            if (cumulative >= target) {
                // Return the bucket's upper bound. Overflow bucket returns -1
                // to signal ">last bucket" — caller decides how to render.
                return i < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[i]! : -1;
            }
        }
        return -1;
    }
    const totalLookups = raw.hits + raw.misses;
    const decoratedByKind: Record<string, unknown> = {};
    for (const [kind, s] of Object.entries(raw.byKind)) {
        const total = s.hits + s.misses;
        const lat = s.loaderLatency;
        decoratedByKind[kind] = {
            hits: s.hits,
            misses: s.misses,
            hitRate: total > 0 ? s.hits / total : null,
            loaderLatency: {
                n: lat.n,
                meanMs: lat.n > 0 ? lat.sumMs / lat.n : null,
                minMs: lat.minMs,
                maxMs: lat.maxMs,
                p50Ms: pct(lat.counts, lat.n, 0.50),
                p95Ms: pct(lat.counts, lat.n, 0.95),
                p99Ms: pct(lat.counts, lat.n, 0.99),
                bucketBoundsMs: LATENCY_BUCKETS_MS,
                counts: lat.counts,
            },
        };
    }
    return {
        epoch: raw.epoch,
        size: raw.size,
        maxSize: raw.maxSize,
        hits: raw.hits,
        misses: raw.misses,
        evictions: raw.evictions,
        invalidations: raw.invalidations,
        hitRate: totalLookups > 0 ? raw.hits / totalLookups : null,
        byKind: decoratedByKind,
    };
}
