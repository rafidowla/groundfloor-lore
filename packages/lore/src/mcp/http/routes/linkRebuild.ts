/**
 * linkRebuild.ts - admin surface for the link rebuild (Loop C / D2).
 *
 *   POST /api/admin/link-rebuild   {workspace, action?: 'start' | 'cancel'}   start (or resume) / cancel a rebuild
 *   GET  /api/admin/link-rebuild[?workspace=ws]                                checkpoint(s): done / total / inserted / invalidated / unchanged
 *
 * Operator-only (same lane as the retention sweep): a rebuild reads every node of the workspace and soft-invalidates
 * link edges. The same counters are also on `/api/admin/stats` (`link.rebuild`) and `/metrics`.
 * Absent (404) when LORE_LINK_ON_ARRIVAL is off.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { LinkService } from '../../../link/linkService.js';
import { gateRoute } from '../../../security/routeGate.js';
import { bindDaemonOperatorLane } from '../../../security/routeWorkspaceBinding.js';
import { requireOperatorForBoundActor } from '../../../security/exportGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeError, parseJsonBody, isInvalidJsonBody, writeInvalidJson } from '../helpers.js';
import { redactError } from '../../../security/logRedact.js';

export interface LinkRebuildDeps {
    linkService: LinkService | null;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
}

const PATH = '/api/admin/link-rebuild';

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

export async function tryLinkRebuildRoutes(
    req: IncomingMessage, res: ServerResponse, url: string, pathname: string, deps: LinkRebuildDeps,
): Promise<boolean> {
    if (pathname !== PATH || (req.method !== 'GET' && req.method !== 'POST')) return false;
    const write = req.method === 'POST';
    const gate = await gateRoute({ deploymentMode: deps.deploymentMode, dataplane: deps.dataplane }, { permission: write ? 'write' : 'read' });
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
    if (!bindDaemonOperatorLane(res, { intent: write ? 'write' : 'read' })) return true;
    if (!requireOperatorForBoundActor(res, 'Link rebuild')) return true;
    const svc = deps.linkService;
    if (!svc || !svc.canRebuild) { writeError(res, 404, 'link_rebuild_unavailable', 'link-on-arrival is not enabled on this host'); return true; }

    if (!write) {
        const ws = new URL(url, 'http://x').searchParams.get('workspace');
        if (ws) {
            const state = svc.rebuildStatus(ws);
            if (!state) { writeError(res, 404, 'no_rebuild', `no link rebuild recorded for workspace '${ws}'`); return true; }
            json(res, 200, { rebuild: state });
        } else {
            json(res, 200, { rebuild: svc.stats().rebuild ?? null });
        }
        return true;
    }

    let body: string;
    try { body = await readBoundedBody(req); } catch (err) {
        if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
        writeError(res, 400, 'invalid_json_body', redactError(err));
        return true;
    }
    try {
        const parsed = parseJsonBody(body) as { workspace?: unknown; action?: unknown } | null;
        const workspace = typeof parsed?.workspace === 'string' ? parsed.workspace.trim() : '';
        const action = parsed?.action === undefined ? 'start' : parsed.action;
        if (!workspace || workspace.length > 200) { writeError(res, 400, 'invalid_workspace', "'workspace' is required"); return true; }
        if (action !== 'start' && action !== 'cancel') { writeError(res, 400, 'invalid_action', "'action' must be 'start' or 'cancel'"); return true; }
        if (action === 'cancel') {
            const cancelled = svc.cancelRebuild(workspace);
            json(res, cancelled ? 202 : 200, { cancelled, rebuild: svc.rebuildStatus(workspace) });
            return true;
        }
        try {
            const out = await svc.startRebuild(workspace);
            json(res, out.alreadyRunning ? 200 : 202, { started: !out.alreadyRunning, resumed: out.resumed, rebuild: out.state });
        } catch (err) {
            const msg = (err as Error).message;
            if (msg === 'workspace_unavailable') writeError(res, 404, 'workspace_unavailable', `workspace '${workspace}' cannot be opened`);
            else if (msg.startsWith('rebuild_unsupported')) writeError(res, 501, 'rebuild_unsupported', msg);
            else throw err;
        }
    } catch (err) {
        if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
        writeError(res, 500, 'internal_error', redactError(err));
    }
    return true;
}
