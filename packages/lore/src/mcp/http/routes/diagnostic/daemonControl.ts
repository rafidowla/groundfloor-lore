/**
 * daemonControl.ts — daemon lifecycle/introspection routes.
 *
 *   POST /api/daemon/restart   — self-exit; launchd KeepAlive relaunches
 *   GET  /api/daemon/logs?tail=N — last N lines of the daemon stderr log
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestShutdown } from '../../../shutdownCoordinator.js';
import { bindDaemonOperatorLane } from '../../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../../security/logRedact.js';
import { writeError } from '../../helpers.js';

export function handleDaemonRestart(res: ServerResponse): void {
    // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
    // local mode. Daemon restart is daemon-wide control, not per-workspace, so
    // this uses the daemon-operator lane rather than a single-workspace bind.
    if (!bindDaemonOperatorLane(res, { intent: 'write' })) return;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, restarting: true }));
    // SP-02 — respond first, THEN run the same ordered drain SIGTERM
    // uses (await outbox replicator, embed queue, sync poller, session
    // cache, consistency sweep, then close the graph engine/LanceDB) before exit.
    // Previously this was setTimeout(process.exit, 150), which hard-killed
    // every in-flight write. launchd KeepAlive relaunches after exit.
    console.error('[Lore MCP] /api/daemon/restart — draining for relaunch.');
    void requestShutdown('daemon-restart');
}

export async function handleDaemonLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // R5-001 — gate like handleDaemonRestart. The daemon stderr log is a single
    // daemon-wide file (absolute paths, error stacks, cross-workspace node ids +
    // workspace names); without this any authenticated principal — including a
    // read-only or workspace-A-scoped app token — could read another app's
    // operational data. Treat reading it as a daemon-admin op (write scope), the
    // same bar as restart. Daemon-operator lane, not a single-workspace bind.
    if (!bindDaemonOperatorLane(res, { intent: 'write' })) return;
    try {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const urlObj = new URL(req.url ?? '/api/daemon/logs', 'http://local');
        const tail = Math.max(1, Math.min(2000, Number(urlObj.searchParams.get('tail')) || 200));
        const logPath = path.join(os.homedir(), 'Library', 'Logs', 'Lore', 'lore-mcp.log');
        // SP-22: guard against materialising a multi-GB log file into memory.
        // If the file exceeds 100MB, reject with a clear message — the operator
        // should rotate before reading (DELETE /api/daemon/logs or launchd restart).
        const LOG_SIZE_LIMIT = 100 * 1024 * 1024;
        let lines: string[] = [];
        try {
            const stat = fs.statSync(logPath);
            if (stat.size > LOG_SIZE_LIMIT) {
                writeError(res, 413, 'log_too_large', 'log too large — rotate first. Restart the daemon or truncate the log file to reduce its size.', {
                    sizeBytes: stat.size,
                    limitBytes: LOG_SIZE_LIMIT,
                });
                return;
            }
            const content = fs.readFileSync(logPath, 'utf-8');
            lines = content.split('\n').filter(Boolean).slice(-tail);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            lines = [];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lines, tail, path: logPath }));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}
