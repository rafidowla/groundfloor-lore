/**
 * audit.ts — Audit log read surface + chat-feedback recording.
 *
 *   GET  /api/audit                — last N entries or since-timestamp slice
 *   POST /api/feedback             — record up/down rating for a chat reply
 *   GET  /api/feedback/stats       — aggregated counts over a window of days
 *
 * Both feedback endpoints are read-only from the daemon's perspective —
 * the FeedbackStore writes a small JSONL file used by the Settings panel
 * to surface "responses thumbed-down per provider" metrics.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { AuditLog } from '../../../security/audit.js';
import { FeedbackStore } from '../../../engines/feedbackStore.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeError } from '../helpers.js';
import { bindDaemonOperatorLane } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';

export interface AuditDeps {
    auditLog: AuditLog;
    feedbackStore: FeedbackStore;
    /** Allows the route to call `gateRoute` for ReBAC checks. */
    deploymentMode: 'local' | 'cloud';
    /** Dataplane handle used by ReBAC checks. Null in local mode. */
    dataplane: GroundfloorClient | null;
}

export async function tryAuditRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: AuditDeps,
): Promise<boolean> {
    if (pathname === '/api/feedback' && req.method === 'POST') {
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. FeedbackStore is a daemon-wide JSONL file (not per-workspace
        // storage), so this uses the daemon-operator lane rather than a
        // single-workspace bind.
        if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
        let fbBody: string;
        try {
            fbBody = await readBoundedBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_json_body', redactError(err));
            return true;
        }
        try {
            const payload = JSON.parse(fbBody || '{}') as {
                messageId?: string;
                provider?: string;
                model?: string;
                rating?: 'up' | 'down';
                query?: string;
                responseLength?: number;
            };
            if (!payload.messageId || !payload.rating || (payload.rating !== 'up' && payload.rating !== 'down')) {
                writeError(res, 400, 'invalid_request_body', 'messageId + rating (up|down) required');
                return true;
            }
            deps.feedbackStore.record({
                messageId: payload.messageId,
                provider: payload.provider ?? 'unknown',
                model: payload.model ?? 'unknown',
                rating: payload.rating,
                queryHash: payload.query ? FeedbackStore.hashQuery(payload.query) : '',
                responseLength: payload.responseLength,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (fbErr) {
            writeError(res, 500, 'internal_error', redactError(fbErr));
        }
        return true;
    }

    // V2.2: aggregate feedback stats for the Settings panel. Window
    // defaults to 30 days, capped at 365 to bound read.
    if (url.startsWith('/api/feedback/stats') && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const parsed = new URL(url, 'http://localhost');
            const days = Math.min(365, Math.max(1, parseInt(parsed.searchParams.get('days') ?? '30', 10) || 30));
            const agg = deps.feedbackStore.aggregate(days);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ windowDays: days, ...agg }));
        } catch (statsErr) {
            writeError(res, 500, 'internal_error', redactError(statsErr));
        }
        return true;
    }

    // C6 — Audit log read surface.
    //   GET /api/audit?tail=N       last N entries (default 100)
    //   GET /api/audit?since=ISO    entries after timestamp
    if (url.startsWith('/api/audit') && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // D-021 — audit export is daemon-wide (AuditLog is not per-workspace
        // storage), so this uses the daemon-operator lane.
        if (!bindDaemonOperatorLane(res, { intent: 'read' })) return true;
        try {
            const parsed = new URL(url, 'http://localhost');
            const since = parsed.searchParams.get('since');
            const tailStr = parsed.searchParams.get('tail');
            let entries;
            if (since) {
                entries = deps.auditLog.since(since);
            } else {
                const n = tailStr ? parseInt(tailStr, 10) : 100;
                entries = deps.auditLog.tail(Number.isFinite(n) ? n : 100);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ entries, count: entries.length }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    return false;
}
