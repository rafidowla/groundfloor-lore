/**
 * governance.ts — schema history, audit, exception-queue, and sync routes.
 *
 *   GET  /api/schema/history                     — snapshot list
 *   POST /api/schema/history/{file}/rollback     — body = {actor}
 *   GET  /api/schema/audit/changes               — schema-change audit log
 *   GET  /api/schema/audit/classifications       — classification audit log
 *   GET  /api/schema/exceptions                  — open exception queue
 *   POST /api/schema/exceptions/{id}/resolve     — body = ExceptionResolution
 *   GET  /api/schema/sync/policies               — per-workspace sync policy
 *   GET  /api/schema/sync/conflicts              — multi-master conflict log
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SchemaChangeAuditFilter, SchemaChangeKind } from '../../../../security/schemaChangeAudit.js';
import type { ExceptionResolution } from '../../../../security/classificationExceptionQueue.js';
import { readJsonBody, writeJson, writeError } from '../../helpers.js';
import { getCurrentPrincipal } from '../../../../auth/principal.js';
import { PREFIX, type SchemaRoutesDeps } from './shared.js';
import { redactError } from '../../../../security/logRedact.js';

/**
 * Wave 4.2 — the per-route scope + requested-workspace gate (formerly
 * denySchemaGovernanceRead, calling requireReadFromWorkspace(getCurrentPrincipal(),
 * requestedWs)) is gone. The family dispatcher (trySchemaRoutes → bindRouteTarget)
 * now binds the request's CONCRETE target — resolved from the SAME `?workspace=`
 * param these routes filter by — with intent='read' for a GET and intent='write'
 * for the POST mutations (history rollback, exception resolve), BEFORE any
 * sub-route runs. So a write-only/read-only token is scope-checked with the right
 * intent, an A-token naming B via `?workspace=B` is 403'd (the R3-002/R4-002
 * concern), and a bootstrap/cross-workspace token targeting a non-boot workspace
 * is 409'd (schema_workspace_not_active) since the boot-wired PhaseAServices can
 * only speak for the boot workspace. This removes the literal-undefined targets
 * banned by arch rule D-021 and the raw auth/principal scope-gate imports here.
 *
 * The `?workspace=` FILTERING below is retained: it narrows the returned rows to
 * the requested workspace. getCurrentPrincipal()?.workspace is used only as the
 * filter default (an omitted param must not return the all-workspaces union), not
 * as a scope gate — the scope check already happened in trySchemaRoutes.
 */

/** Returns true once a response has been written. */
export async function tryGovernanceRoutes(req: IncomingMessage, res: ServerResponse, url: string, pathname: string, deps: SchemaRoutesDeps): Promise<boolean> {
    /* ─── history + rollback ──────────────────────────────────── */

    if (pathname === `${PREFIX}/history` && req.method === 'GET') {
        try {
            writeJson(res, 200, { snapshots: deps.phaseA.schemaAuthoring.listHistory() });
        } catch (e) { writeError(res, 500, 'list_history_failed', redactError(e)); }
        return true;
    }

    const historyPrefix = `${PREFIX}/history/`;
    if (pathname.startsWith(historyPrefix) && pathname.endsWith('/rollback') && req.method === 'POST') {
        // L-020 — schema rollback is a destructive DDL write. The write-scope +
        // workspace-confinement check now runs in trySchemaRoutes (bindRouteTarget,
        // intent='write' for this POST), so a read-only or foreign-workspace token
        // is already 403'd/409'd before reaching here.
        const inner = pathname.slice(historyPrefix.length, -('/rollback'.length));
        const file = decodeURIComponent(inner);
        try {
            const body = await readJsonBody(req) as { actor?: string };
            if (!body?.actor) {
                writeError(res, 400, 'invalid_rollback_body', 'body must be {actor: string}');
                return true;
            }
            deps.phaseA.schemaAuthoring.rollback(file, body.actor);
            writeJson(res, 200, { rolledBackTo: file, actor: body.actor });
        } catch (e) {
            const msg = (e as Error).message;
            const status = /not found|missing/i.test(msg) ? 404 : 500;
            writeError(res, status, 'rollback_failed', redactError(e));
        }
        return true;
    }

    /* ─── audit logs ─────────────────────────────────────────── */

    if (pathname === `${PREFIX}/audit/changes` && req.method === 'GET') {
        const u = new URL(url, 'http://x');
        // R3-002 — resolve the requested ws (default to the principal's own so an
        // omitted param can't return the all-workspaces union), gate against it,
        // then force the filter to that same ws.
        const auditWs = u.searchParams.get('workspace') ?? getCurrentPrincipal()?.workspace ?? undefined;
        try {
            const filter: SchemaChangeAuditFilter = {
                sinceIso: u.searchParams.get('since') ?? undefined,
                untilIso: u.searchParams.get('until') ?? undefined,
                workspace: auditWs,
                kind: (u.searchParams.get('kind') ?? undefined) as SchemaChangeKind | undefined,
                targetPrefix: u.searchParams.get('target') ?? undefined,
                limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : undefined,
            };
            writeJson(res, 200, { entries: deps.phaseA.schemaChangeAudit.list(filter) });
        } catch (e) { writeError(res, 500, 'audit_changes_failed', redactError(e)); }
        return true;
    }

    if (pathname === `${PREFIX}/audit/classifications` && req.method === 'GET') {
        const u = new URL(url, 'http://x');
        // R3-002 — see /audit/changes above.
        const classWs = u.searchParams.get('workspace') ?? getCurrentPrincipal()?.workspace ?? undefined;
        try {
            const filter = {
                sinceIso: u.searchParams.get('since') ?? undefined,
                untilIso: u.searchParams.get('until') ?? undefined,
                workspace: classWs,
                limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : undefined,
            };
            writeJson(res, 200, { entries: deps.phaseA.classificationAudit.list(filter) });
        } catch (e) { writeError(res, 500, 'audit_classifications_failed', redactError(e)); }
        return true;
    }

    /* ─── exceptions ─────────────────────────────────────────── */

    if (pathname === `${PREFIX}/exceptions` && req.method === 'GET') {
        const u = new URL(url, 'http://x');
        // R3-002 — see /audit/changes above.
        const excWs = u.searchParams.get('workspace') ?? getCurrentPrincipal()?.workspace ?? undefined;
        try {
            const filter = {
                workspace: excWs,
                limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : undefined,
            };
            writeJson(res, 200, { entries: deps.phaseA.exceptionQueue.listOpen(filter) });
        } catch (e) { writeError(res, 500, 'list_exceptions_failed', redactError(e)); }
        return true;
    }

    const exceptionsPrefix = `${PREFIX}/exceptions/`;
    if (pathname.startsWith(exceptionsPrefix) && pathname.endsWith('/resolve') && req.method === 'POST') {
        // B5 (audit 2026-06-18) — resolving a classification exception is a
        // durable write (appends to exception-queue.resolved.jsonl and rewrites
        // the open queue). The write-scope + workspace-confinement check now runs
        // in trySchemaRoutes (bindRouteTarget, intent='write' for this POST), so a
        // read-only or foreign-workspace token is already 403'd/409'd upstream.
        const inner = pathname.slice(exceptionsPrefix.length, -('/resolve'.length));
        const exceptionId = decodeURIComponent(inner);
        try {
            const body = await readJsonBody(req) as Omit<ExceptionResolution, 'id'>;
            // 2.4 (2026-08-17) — resolvedBy/resolvedAt land in the durable audit
            // JSONL; they must come from the authenticated principal + server
            // clock, never a client-supplied string (which would forge the audit).
            const principal = getCurrentPrincipal();
            const resolution = {
                id: exceptionId,
                ...body,
                resolvedBy: principal?.label ? `human:${principal.label}` : body.resolvedBy,
                resolvedAt: new Date().toISOString(),
            } as ExceptionResolution;
            const rec = deps.phaseA.exceptionQueue.resolve(resolution);
            writeJson(res, 200, rec);
        } catch (e) {
            const msg = (e as Error).message;
            const status = /not found|missing/i.test(msg) ? 404 : 500;
            writeError(res, status, 'resolve_exception_failed', redactError(e));
        }
        return true;
    }

    /* ─── sync ──────────────────────────────────────────────── */

    if (pathname === `${PREFIX}/sync/policies` && req.method === 'GET') {
        const u = new URL(url, 'http://x');
        // R4-002 — syncGuard.list() is the all-workspace policy map; gate against
        // the requested ws (default to the principal's own) and filter to it so a
        // scoped token can't read another app's sync policy. No ws (null principal
        // / local bypass) → full list.
        const syncWs = u.searchParams.get('workspace') ?? getCurrentPrincipal()?.workspace ?? undefined;
        try {
            const all = deps.phaseA.syncGuard.list();
            const policies = syncWs ? all.filter((e) => e.workspace === syncWs) : all;
            writeJson(res, 200, { policies });
        } catch (e) { writeError(res, 500, 'list_policies_failed', redactError(e)); }
        return true;
    }

    if (pathname === `${PREFIX}/sync/conflicts` && req.method === 'GET') {
        // R4-002 — the multi-master conflict log is a single daemon-wide JSONL.
        // ConflictEntry now carries a `workspace` tag (set by the per-workspace
        // MultiMasterMerger), so resolve the requested ws (default the principal's
        // own), gate against it, and filter the log to it — a scoped token no
        // longer enumerates other workspaces' conflict history (and legacy
        // untagged entries are excluded by the filter). Mirrors /audit/changes.
        const u = new URL(url, 'http://x');
        const conflictWs = u.searchParams.get('workspace') ?? getCurrentPrincipal()?.workspace ?? undefined;
        try {
            const filter = {
                nodeId: u.searchParams.get('nodeId') ?? undefined,
                sinceIso: u.searchParams.get('since') ?? undefined,
                limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : undefined,
                workspace: conflictWs,
            };
            writeJson(res, 200, { entries: deps.phaseA.conflictLog.list(filter) });
        } catch (e) { writeError(res, 500, 'list_conflicts_failed', redactError(e)); }
        return true;
    }

    return false;
}
