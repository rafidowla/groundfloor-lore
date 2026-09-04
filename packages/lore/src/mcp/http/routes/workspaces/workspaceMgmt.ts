/**
 * workspaceMgmt.ts — workspace CRUD routes.
 *
 *   GET    /api/workspaces                     — list all
 *   POST   /api/workspaces                     — create
 *   POST   /api/workspaces/switch              — switch active (daemon restart)
 *   POST   /api/workspaces/rename              — rename label
 *   DELETE /api/workspaces/:name               — delete
 *   PATCH  /api/workspaces/:name/retention     — patch retention policy
 *   GET    /api/workspaces/:name/retention     — read retention policy
 *
 * Order is preserved from the pre-split handler: the exact /switch and
 * /rename matches MUST precede the `pathname.startsWith('/api/workspaces/')`
 * DELETE/retention checks.
 *
 * F-DEL8 — the DELETE/retention checks below match and slice on
 * `pathname` (query-stripped), not the raw `url`. They used to match
 * on `url`, so `DELETE /api/workspaces/foo?workspace=x` sliced the
 * name as `foo?workspace=x` (mangled into an unknown-workspace 400)
 * and any `?query` on the retention routes broke the `url.endsWith
 * ('/retention')` match outright. `url` (with its query string) is
 * still accepted as a parameter here in case a future route needs it,
 * but nothing in this file should slice a workspace name out of it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    loadWorkspaces,
    renameWorkspace,
    getActiveWorkspaceName,
    createWorkspace,
    switchWorkspace,
    deleteWorkspace,
    kebabCase,
    getWorkspaceRetention,
    setWorkspaceRetention,
} from '../../../../config/workspaces.js';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { isPayloadTooLarge, writeOversizeError, writeError, parseJsonBody, isInvalidJsonBody, writeInvalidJson } from '../../helpers.js';
import { requestShutdown } from '../../../shutdownCoordinator.js';
import { bindDaemonOperatorLane, bindRouteTarget } from '../../../../security/routeWorkspaceBinding.js';
import { type WorkspacesDeps, readBody } from './shared.js';
import { redactError } from '../../../../security/logRedact.js';

/**
 * F-LOW-R26 — allowlist of known workspace sync modes. Mirrors the documented
 * `WorkspaceEntry.mode` values in config/workspaces.ts ("Sync mode"). The
 * create route rejects any other value with 400 rather than forwarding
 * arbitrary client input into the persisted workspaces.json.
 */
const WORKSPACE_MODES = ['local-only', 'local-sync', 'cloud-only'] as const;

/**
 * F-B3 (Wave 4.1) — workspace CRUD is daemon-wide control-plane surface (it
 * mutates workspaces.json / manages many workspaces), so it uses the shared
 * bindDaemonOperatorLane (security/routeWorkspaceBinding.ts) rather than a
 * single-workspace bindRouteTarget. Semantics are identical to the original
 * local denyWorkspaceMutation this replaces: null principal → local/legacy
 * bypass; bootstrap/shared-secret → allowed (the operator manages ANY
 * workspace); app token → confined to its own workspace unless it holds
 * cross-workspace-write. Returns true once a 4xx has been written (caller
 * must `return true`).
 */
function denyWorkspaceMutation(res: ServerResponse, target: string): boolean {
    return !bindDaemonOperatorLane(res, { intent: 'write', requested: target });
}

/** Returns true once a response has been written. */
export async function tryWorkspaceMgmtRoutes(req: IncomingMessage, res: ServerResponse, url: string, pathname: string, deps: WorkspacesDeps): Promise<boolean> {
    if (pathname === '/api/workspaces' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(loadWorkspaces()));
        return true;
    }

    if (pathname === '/api/workspaces' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'administer' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068 — per-token write-scope gate: gateRoute above is a no-op in local
        // mode, so without this a read-only app token could invoke this mutating
        // route. Null principal = local/legacy bypass (preserved).
        let body: string;
        try {
            body = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_request', redactError(err));
            return true;
        }
        try {
            const { name: rawName, label, mode, template } = parseJsonBody(body) as {
                name?: string;
                label?: string;
                mode?: string;
                template?: string;
            };
            if (!rawName) {
                writeError(res, 400, 'name_required', 'name required');
                return true;
            }
            // F-LOW-R26 — validate the client-supplied sync `mode` against the
            // known allowlist instead of forwarding arbitrary input verbatim
            // into createWorkspace (which writes it straight to workspaces.json).
            // Allowed values mirror WorkspaceEntry.mode in config/workspaces.ts.
            if (mode !== undefined && !(WORKSPACE_MODES as readonly string[]).includes(mode)) {
                writeError(res, 400, 'invalid_mode', `invalid mode "${mode}" (expected one of: ${WORKSPACE_MODES.join(', ')})`);
                return true;
            }
            // D2-authz-3 — gate on the NORMALIZED name createWorkspace will
            // actually persist, not the raw body name. createWorkspace kebab-
            // cases its input, so gating on the raw name let a token bound to
            // ws-a pass with a raw value that normalizes to a different
            // workspace (and over-blocked legit creates whose raw form differed
            // only by casing/spacing). Derive the canonical name first and gate
            // F-B3 on the same value createWorkspace uses.
            const name = kebabCase(rawName);
            // F-B3 — gate on the workspace being CREATED, not the token's own.
            if (denyWorkspaceMutation(res, name)) return true;
            const entry = createWorkspace(name, { label, mode, template });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ created: entry, workspaces: loadWorkspaces() }));
        } catch (err) {
            // X-json400 (2026-09-03 audit) — already 400, but redactError
            // garbled the JSON.parse diagnostic; route through
            // writeInvalidJson for a clean, non-hashed message instead.
            if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
            writeError(res, 400, 'invalid_request', redactError(err));
        }
        return true;
    }

    if (pathname === '/api/workspaces/switch' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068 — per-token write-scope gate: gateRoute above is a no-op in local
        // mode, so without this a read-only app token could invoke this mutating
        // route. Null principal = local/legacy bypass (preserved).
        let body: string;
        try {
            body = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_request', redactError(err));
            return true;
        }
        try {
            const { name } = parseJsonBody(body) as { name?: string };
            if (!name) {
                writeError(res, 400, 'name_required', 'name required');
                return true;
            }
            // F-B3 — gate on the workspace being switched to (daemon rebinds to it).
            if (denyWorkspaceMutation(res, name)) return true;
            if (name === getActiveWorkspaceName()) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ active: name, restarting: false }));
                return true;
            }
            switchWorkspace(name);
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ active: name, restarting: true }));
            // SP-02 — respond first, THEN run the same ordered drain
            // SIGTERM uses (await outbox replicator, embed queue, sync
            // poller, session cache, consistency sweep, then close the
            // graph engine/LanceDB) before exit. Previously
            // setTimeout(process.exit, 150) hard-killed every in-flight
            // write — a half-applied graph transaction could wedge the
            // next boot. launchd KeepAlive=true
            // relaunches and binds the new workspace on the next boot.
            console.error(`[Lore MCP] Workspace switched to "${name}" — draining for restart.`);
            void requestShutdown('workspace-switch');
        } catch (err) {
            // X-json400 (2026-09-03 audit) — see the create-workspace
            // handler above for why the JSON-parse case bypasses redactError.
            if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
            writeError(res, 400, 'invalid_request', redactError(err));
        }
        return true;
    }

    // POST /api/workspaces/rename  body: { oldName, newName }
    // Renames a workspace's label without moving its data on disk. No
    // daemon restart needed — workspaces.json is read fresh on each
    // loadWorkspaces() call. Active-workspace rename is supported.
    if (pathname === '/api/workspaces/rename' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068 — per-token write-scope gate: gateRoute above is a no-op in local
        // mode, so without this a read-only app token could invoke this mutating
        // route. Null principal = local/legacy bypass (preserved).
        let body: string;
        try {
            body = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_request', redactError(err));
            return true;
        }
        const startMs = Date.now();
        try {
            const { oldName, newName } = parseJsonBody(body) as { oldName?: string; newName?: string };
            if (!oldName || !newName) {
                writeError(res, 400, 'names_required', 'oldName and newName required');
                return true;
            }
            // F-B3 — gate on the workspace being RENAMED (its current name).
            if (denyWorkspaceMutation(res, oldName)) return true;
            const next = renameWorkspace(oldName, newName);
            deps.auditLog.log({
                toolName: 'workspaces.rename',
                args: { oldName, newName },
                result: 'success',
                durationMs: Date.now() - startMs,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(next));
        } catch (err) {
            deps.auditLog.log({
                toolName: 'workspaces.rename',
                args: { rawBody: body.slice(0, 200) },
                result: 'error',
                resultDetail: (err as Error).message,
                durationMs: Date.now() - startMs,
            });
            // X-json400 (2026-09-03 audit) — see the create-workspace
            // handler above for why the JSON-parse case bypasses redactError.
            if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
            writeError(res, 400, 'invalid_request', redactError(err));
        }
        return true;
    }

    if (pathname.startsWith('/api/workspaces/') && req.method === 'DELETE') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'delete' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068 — per-token write-scope gate: gateRoute above is a no-op in local
        // mode, so without this a read-only app token could invoke this mutating
        // route. Null principal = local/legacy bypass (preserved).
        const raw = decodeURIComponent(pathname.slice('/api/workspaces/'.length));
        // C6 — workspace deletion is destructive: audit every attempt
        // regardless of outcome.
        const startMs = Date.now();
        try {
            const name = kebabCase(raw);
            // F-B3 — gate on the workspace named in the URL, not the token's own.
            if (denyWorkspaceMutation(res, name)) return true;
            const next = deleteWorkspace(name);
            deps.auditLog.log({
                toolName: 'workspaces.delete',
                args: { name },
                result: 'success',
                durationMs: Date.now() - startMs,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(next));
        } catch (err) {
            deps.auditLog.log({
                toolName: 'workspaces.delete',
                args: { name: raw },
                result: 'error',
                resultDetail: (err as Error).message,
                durationMs: Date.now() - startMs,
            });
            writeError(res, 400, 'invalid_request', redactError(err));
        }
        return true;
    }

    // PATCH /api/workspaces/:name/retention  body: Partial<WorkspaceRetentionPolicy>
    if (pathname.startsWith('/api/workspaces/') && pathname.endsWith('/retention') && req.method === 'PATCH') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068 — per-token write-scope gate: gateRoute above is a no-op in local
        // mode, so without this a read-only app token could invoke this mutating
        // route. Null principal = local/legacy bypass (preserved).
        const namePart = decodeURIComponent(pathname.slice('/api/workspaces/'.length, -'/retention'.length));
        // F-B3 — gate on the workspace whose retention policy is being mutated.
        if (denyWorkspaceMutation(res, namePart)) return true;
        let body: string;
        try {
            body = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_request', redactError(err));
            return true;
        }
        try {
            const patch = parseJsonBody(body) as Record<string, unknown>;
            const updated = setWorkspaceRetention(namePart, patch);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(updated));
        } catch (err) {
            // X-json400 (2026-09-03 audit) — see the create-workspace
            // handler above for why the JSON-parse case bypasses redactError.
            if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
            writeError(res, 400, 'invalid_request', redactError(err));
        }
        return true;
    }

    // GET /api/workspaces/:name/retention
    if (pathname.startsWith('/api/workspaces/') && pathname.endsWith('/retention') && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        const namePart = decodeURIComponent(pathname.slice('/api/workspaces/'.length, -'/retention'.length));
        // D2-authz-2/D-021 — gateRoute('read') is a no-op in local mode, so an
        // app token bound to ws-A could read ws-B's retention policy (IDOR).
        // Bind to the workspace named in the URL, mirroring the PATCH sibling.
        if (bindRouteTarget(res, { requested: namePart, intent: 'read' }) === null) return true;
        const policy = getWorkspaceRetention(namePart);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(policy));
        return true;
    }

    return false;
}
