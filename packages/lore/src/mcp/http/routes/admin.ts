/**
 * admin.ts — Consent queue, retention sweep, MCP-client +
 * connector status. The grab-bag of small admin/control surfaces.
 *
 *   GET  /api/consent/pending          — list pending consent requests
 *   POST /api/consent/:id/resolve      — resolve a pending consent request
 *   POST /api/retention/sweep          — retention sweep
 *   GET  /api/retention                — list retention rules
 *   GET  /api/mcp-clients              — outward MCP client connection state
 *   GET  /api/connectors               — connector registry status
 *   POST /api/connectors/:name/health  — fresh health probe (calls health())
 *
 * The consent endpoints used to live under `/api/approvals` and
 * `/api/approval/:id`, but those names now belong to the HITL pending-
 * ops queue (see routes/approvals.ts). The consent surface is a
 * different concept (in-process MCP-tool approvals managed by
 * ConsentManager); the new paths make that distinction explicit.
 *
 * Note: this is the RetentionSweeper + archiveSink sweep. The
 * *workspace*-level retention surface (/api/workspace/retention*)
 * lives in retention.ts and is unrelated.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { ConsentManager } from '../../../security/consent.js';
import type { RetentionSweeper } from '../../../engines/retentionSweep.js';
import type { LocalFileSink } from '../../../engines/archive.js';
import type { McpClientRuntime } from '../../../engines/mcpClient/runtime.js';
import type { ConnectorRegistry } from '../../../engines/connectors/registry.js';
import type { AuditLog } from '../../../security/audit.js';
import { gateRoute } from '../../../security/routeGate.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import { bindDaemonOperatorLane } from '../../../security/routeWorkspaceBinding.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { loadExtraIngestionRoots, saveExtraIngestionRoots, isIngestionConfigured, isWatchRootSafe } from '../../../security/pathAllowlist.js';
import { loreHome } from '../../../config/loreHome.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeError } from '../helpers.js';
import { redactError } from '../../../security/logRedact.js';

export interface AdminDeps {
    consentManager: ConsentManager;
    retentionSweeper: RetentionSweeper;
    archiveSink: LocalFileSink;
    mcpClientRuntime: McpClientRuntime;
    connectorRegistry: ConnectorRegistry;
    auditLog: AuditLog;
    /** Allows the route to call `gateRoute` for ReBAC checks. */
    deploymentMode: 'local' | 'cloud';
    /** Dataplane handle used by ReBAC checks. Null in local mode. */
    dataplane: GroundfloorClient | null;
}

export async function tryAdminRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: AdminDeps,
): Promise<boolean> {
    // C6 — List pending consent requests. UI "Pending actions" panel
    // polls or long-polls this. Entries live ~60s then auto-deny.
    if (pathname === '/api/consent/pending' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // F-B2 — scope the pending list to the caller's workspace. The
        // ConsentManager registry is process-global across all workspaces, so an
        // unfiltered list() leaks other workspaces' pending destructive approvals
        // (args carry node content/targets). An admin holding cross-workspace-read
        // gets the full view; a null principal is local/legacy bypass (unfiltered).
        const listPrincipal = getCurrentPrincipal();
        const listFilter = listPrincipal && !listPrincipal.scopes.includes('cross-workspace-read')
            ? listPrincipal.workspace
            : undefined;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pending: deps.consentManager.list(listFilter) }));
        return true;
    }

    // C6 — Resolve a pending consent request.
    // POST body: {approved: boolean, reason?}
    const consentResolveMatch = pathname.match(/^\/api\/consent\/([^/]+)\/resolve$/);
    if (consentResolveMatch && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode, so without this a read-only app token could invoke this
        // mutating route. Consent resolution is daemon-wide (ConsentManager is a
        // process-global registry, not workspace-scoped storage), so this uses
        // the daemon-operator lane rather than a single-workspace bind.
        if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
        const principal = getCurrentPrincipal();
        const id = consentResolveMatch[1]!;
        let body: string;
        try {
            body = await readBoundedBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_json_body', redactError(err));
            return true;
        }
        try {
            const payload = JSON.parse(body || '{}') as { approved?: boolean; reason?: string };
            if (typeof payload.approved !== 'boolean') {
                writeError(res, 400, 'invalid_request_body', 'approved must be boolean');
                return true;
            }
            // F-B2 — enforce workspace ownership on resolve. Without an
            // expectedWorkspace, a caller in workspace A could resolve workspace
            // B's pending approval (keyed only by UUID). Pass the caller's
            // workspace unless it's an admin (cross-workspace-write) or a null
            // principal (local/legacy bypass), which keep the unscoped behavior.
            const expectedWorkspace = principal && !principal.scopes.includes('cross-workspace-write')
                ? principal.workspace
                : undefined;
            const ok = deps.consentManager.resolve(id, payload.approved, payload.reason, expectedWorkspace);
            res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok, id }));
        } catch (err) {
            writeError(res, 400, 'invalid_request_body', redactError(err));
        }
        return true;
    }

    // Phase 6 — Retention sweep trigger (dry-run by default).
    //   POST /api/retention/sweep {apply?: boolean}
    // Applies are consent-gated because archive mutates node content
    // (replaces with placeholder + sourceRef).
    if (pathname === '/api/retention/sweep' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. Retention sweep is a daemon-wide operation (RetentionSweeper
        // + archiveSink operate over the boot workspace as a daemon facility, not
        // per-workspace storage reachable by URL/body), so this uses the
        // daemon-operator lane rather than a single-workspace bind.
        if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
        const principal = getCurrentPrincipal();
        let body: string;
        try {
            body = await readBoundedBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_json_body', redactError(err));
            return true;
        }
        const startMs = Date.now();
        try {
            const { apply } = JSON.parse(body || '{}') as {
                apply?: boolean;
            };
            let approvalId: string | undefined;
            if (apply) {
                const cReq = deps.consentManager.request(
                    'retention.sweep.apply',
                    {},
                    {
                        context: 'Apply retention policy. Archives eligible node contents; for `delete` and `evict-content` actions, applied sweep currently defers to the consent-UI followup.',
                        // F-B2 — tag the pending entry with the requesting workspace so
                        // it's only visible/resolvable within that workspace.
                        workspaceId: principal?.workspace,
                    },
                );
                approvalId = cReq.id;
                const decision = await cReq.wait;
                if (!decision.approved) {
                    deps.auditLog.log({
                        toolName: 'retention.sweep',
                        args: { apply },
                        result: 'denied-by-user',
                        resultDetail: decision.reason,
                        approvalId,
                        durationMs: Date.now() - startMs,
                    });
                    writeError(res, 403, 'consent_denied', decision.reason ?? 'consent denied', { reason: decision.reason });
                    return true;
                }
            }
            const result = await deps.retentionSweeper.sweep({
                dryRun: !apply,
                sink: deps.archiveSink,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            deps.auditLog.log({
                toolName: 'retention.sweep',
                args: {},
                result: 'error',
                resultDetail: (err as Error).message,
                durationMs: Date.now() - startMs,
            });
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    // C12 — List active retention rules.
    // Daily-sweep enforcement is a separate runtime; exposing the rules
    // now lets the UI show them and catches misconfigurations early.
    if (pathname === '/api/retention' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rules: [] }));
        return true;
    }

    // C6b — External MCP client status.
    if (pathname === '/api/mcp-clients' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ clients: deps.mcpClientRuntime.list() }));
        return true;
    }

    // Manual sync trigger. Drains the connector's sync iterator and returns
    // a summary. Long-running connectors will block until complete — suitable
    // for admin one-shots, not large scheduled ingests.
    const syncMatch = pathname.match(/^\/api\/connectors\/([a-z][a-z0-9-]*)\/sync$/);
    if (syncMatch && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate (connector sync drives
        // ingestion; a read-only token must not trigger it). gateRoute above is a
        // no-op in local mode. Connectors are a daemon-wide registry (not
        // per-workspace addressable via URL/body), so this uses the
        // daemon-operator lane rather than a single-workspace bind.
        if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
        const name = syncMatch[1]!;
        const startMs = Date.now();
        let itemCount = 0;
        try {
            for await (const _ of deps.connectorRegistry.syncOne(name)) {
                itemCount++;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ name, ok: true, itemCount, durationMs: Date.now() - startMs }));
        } catch (err) {
            deps.auditLog.log({
                toolName: 'connectors.sync',
                args: { name },
                result: 'error',
                resultDetail: (err as Error).message,
                durationMs: Date.now() - startMs,
            });
            // NB: this is a 200 sync-RESULT summary (ok:false signals the
            // per-connector outcome), not an HTTP error envelope — so it does
            // not go through writeError. `errorDetail` (not `error`) keeps it
            // off the canonical-envelope key so the freeze ratchet stays clean.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ name, ok: false, itemCount, errorDetail: redactError(err), durationMs: Date.now() - startMs }));
        }
        return true;
    }

    // Per-connector health probe. POST so it's not idempotent in the
    // browser cache; the body is empty. Uses ConnectorRegistry.healthOf
    // which falls back to defaultHealth (isAuthenticated proxy) when a
    // connector doesn't implement health() itself.
    const healthMatch = pathname.match(/^\/api\/connectors\/([a-z][a-z0-9-]*)\/health$/);
    if (healthMatch && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        const name = healthMatch[1]!;
        try {
            const result = await deps.connectorRegistry.healthOf(name);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ name, ...result }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err), { name, ok: false });
        }
        return true;
    }

    // Filesystem connector paths — Settings → Connectors → Filesystem UI.
    // Added 2026-05-14. GET returns the user-configured allowlist plus the
    // built-in defaults (read-only) for display. PATCH replaces the user
    // allowlist atomically. Path existence is NOT enforced — users may
    // legitimately add a path that will exist in another mount soon.
    if (pathname === '/api/connectors/filesystem/paths' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const os = await import('node:os');
            const path = await import('node:path');
            const home = os.homedir();
            const suggestedDefaults = [
                path.join(home, 'Documents'),
                path.join(home, 'Downloads'),
                path.join(home, 'Desktop'),
            ];
            const home_ = loreHome();
            const configured = isIngestionConfigured(home_);
            // 2026-05-14: single-list model. roots = user's saved list when
            // they've configured anything (even an empty list), otherwise
            // the suggested defaults so the UI shows a sensible starting
            // point on first run.
            const roots = configured ? loadExtraIngestionRoots(home_) : suggestedDefaults;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ roots, isConfigured: configured, suggestedDefaults }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }
    if (pathname === '/api/connectors/filesystem/paths' && req.method === 'PATCH') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. Ingestion roots are daemon-wide config (loreHome()-scoped,
        // not per-workspace), so this uses the daemon-operator lane rather than a
        // single-workspace bind.
        if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
        let body: string;
        try {
            body = await readBoundedBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_json_body', redactError(err));
            return true;
        }
        try {
            const parsed = JSON.parse(body || '{}') as { roots?: unknown };
            if (!Array.isArray(parsed.roots)) {
                writeError(res, 400, 'invalid_request_body', 'roots must be an array of strings');
                return true;
            }
            // RC2 audit (2026-05-17): silently dropping non-string
            // entries (e.g. PATCH {"roots":[null,42,"/tmp"]}) hid
            // misconfigured callers — they got a 200 back and never
            // learned their null / numeric / nested entries were
            // discarded. Reject the whole payload instead.
            const badIndex = (parsed.roots as unknown[]).findIndex(
                (r) => typeof r !== 'string' || r.length === 0,
            );
            if (badIndex !== -1) {
                writeError(res, 400, 'invalid_request_body', `roots[${badIndex}] must be a non-empty string`);
                return true;
            }
            const incoming = parsed.roots as string[];
            // NW-1a: pre-flight every root against isWatchRootSafe and
            // refuse the whole PATCH (HTTP 400) on the first failure, so
            // the persisted ingestion.json is never partially-updated and
            // the caller learns exactly which entry was rejected. Mirrors
            // the LORE_WATCH_PATHS behavior SW-15 established.
            const unsafeIndex = incoming.findIndex((r) => !isWatchRootSafe(r));
            if (unsafeIndex !== -1) {
                writeError(res, 400, 'invalid_request_body', `roots[${unsafeIndex}] is not a safe ingestion root (must be an absolute path strictly under your home directory, not a system root)`);
                return true;
            }
            saveExtraIngestionRoots(loreHome(), incoming);
            const persisted = loadExtraIngestionRoots(loreHome());
            const os = await import('node:os');
            const path = await import('node:path');
            const home = os.homedir();
            const suggestedDefaults = [
                path.join(home, 'Documents'),
                path.join(home, 'Downloads'),
                path.join(home, 'Desktop'),
            ];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ roots: persisted, isConfigured: true, suggestedDefaults }));
        } catch (err) {
            writeError(res, 400, 'invalid_request_body', redactError(err));
        }
        return true;
    }

    // C5 — Connector status. Lists registered connectors + last-sync
    // state. UI "Sources" panel will poll this.
    if (pathname === '/api/connectors' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const status = deps.connectorRegistry.listStatus();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ connectors: status }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    return false;
}
