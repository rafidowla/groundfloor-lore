/**
 * diagnostic.ts — dispatcher for liveness, capability, and introspection
 * routes. Each endpoint lives under ./diagnostic/; this module matches
 * (pathname, method) and delegates.
 *
 *   POST /api/daemon/restart       — self-exit; launchd relaunches  (diagnostic/daemonControl.ts)
 *   GET  /api/daemon/logs?tail=N   — last N lines of daemon stderr   (diagnostic/daemonControl.ts)
 *   GET  /health                   — minimal liveness probe          (diagnostic/health.ts)
 *   GET  /api/diagnose/consistency — tri-substrate consistency       (diagnostic/health.ts)
 *   GET  /api/health               — full daemon health snapshot     (diagnostic/health.ts)
 *   POST /api/admin/stats          — cross-workspace global view      (diagnostic/stats.ts)
 *   GET  /api/stats                — workspace-scoped counts          (diagnostic/stats.ts)
 *   GET  /api/capabilities         — machine capability probe         (diagnostic/stats.ts)
 *   GET  /api/report               — markdown digest of active graph  (diagnostic/storage.ts)
 *   GET  /api/storage              — per-workspace disk + quota state  (diagnostic/storage.ts)
 *   GET  /api/diagnostic/hardware  — hardware probe + tier rec         (diagnostic/storage.ts)
 *   GET/DELETE /api/diagnostic/cache-stats — read/reset cache counters (diagnostic/storage.ts)
 *
 * `/api/auth/bootstrap` is served by `runHttpGates` (it must short-circuit
 * before the workspace/orphan gates), so it is NOT in this family.
 *
 * Wire format is byte-for-byte identical to the inline handlers in
 * server.ts pre-extraction. Any drift here is a regression.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DiagnosticDeps } from './diagnostic/shared.js';
import { handleDaemonRestart, handleDaemonLogs } from './diagnostic/daemonControl.js';
import { handleHealthLite, handleConsistency, handleConsistencyCleanup, handleHealth } from './diagnostic/health.js';
import { handleAdminStats, handleStats, handleCapabilities } from './diagnostic/stats.js';
import { handleReport, handleStorage, handleHardware, handleCacheStats } from './diagnostic/storage.js';

export type { DiagnosticDeps } from './diagnostic/shared.js';

/**
 * tryDiagnosticRoutes — Match a diagnostic route or return false.
 *
 * Returns true once a response has been written; the caller bails out.
 */
export async function tryDiagnosticRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: DiagnosticDeps,
): Promise<boolean> {
    if (pathname === '/api/daemon/restart' && req.method === 'POST') {
        handleDaemonRestart(res);
        return true;
    }
    if (pathname === '/api/daemon/logs' && req.method === 'GET') {
        await handleDaemonLogs(req, res);
        return true;
    }
    if (pathname === '/health' && req.method === 'GET') {
        handleHealthLite(res, deps);
        return true;
    }
    if (pathname === '/api/diagnose/consistency' && req.method === 'GET') {
        await handleConsistency(res, url, deps);
        return true;
    }
    if (pathname === '/api/diagnose/consistency/cleanup' && req.method === 'POST') {
        await handleConsistencyCleanup(res, url, deps);
        return true;
    }
    if (pathname === '/api/admin/stats' && req.method === 'POST') {
        await handleAdminStats(res, deps);
        return true;
    }
    if (pathname === '/api/stats' && req.method === 'GET') {
        await handleStats(res, url, deps);
        return true;
    }
    if (pathname === '/api/capabilities' && req.method === 'GET') {
        await handleCapabilities(res);
        return true;
    }
    if (pathname === '/api/health' && req.method === 'GET') {
        await handleHealth(res, url, deps);
        return true;
    }
    if (url.startsWith('/api/report') && req.method === 'GET') {
        await handleReport(res, url, deps);
        return true;
    }
    if (pathname === '/api/storage' && req.method === 'GET') {
        handleStorage(res);
        return true;
    }
    if (pathname === '/api/diagnostic/hardware' && req.method === 'GET') {
        await handleHardware(res, deps);
        return true;
    }
    if (pathname === '/api/diagnostic/cache-stats') {
        await handleCacheStats(req, res, deps);
        return true;
    }
    return false;
}
