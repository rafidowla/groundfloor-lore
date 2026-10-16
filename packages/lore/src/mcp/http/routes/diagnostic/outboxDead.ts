/**
 * outboxDead.ts - GET /api/outbox/dead (3.35.0 (a)/(p)).
 *
 * A paginated, READ-ONLY, workspace-scoped list of dead-lettered outbox rows: writes the caller was
 * told were accepted but that the replicator gave up on. Until now these were only visible by
 * opening outbox.sqlite.
 *
 *   GET /api/outbox/dead?workspace=<ws>&limit=<1..200, default 50>&offset=<n>
 *
 * Response: { workspace, deadLettered, deadSuperseded, deadByReason, total, rows, limit, offset,
 *             hasMore, cap }. `deadLettered` excludes RA-6-superseded rows (nothing is missing for
 * those; they are listed with reason 'superseded'). Each row: id, operationKind, nodeId (node and
 * verbatim families), reason, createdAt, firstTransientAt, deadAt, attempts, transientRetries,
 * sequenceId, and `lastError` for unbound/operator callers only (it can embed row content, so a
 * bound app token does not get it - same audience split as /api/stats).
 *
 * Confinement: the SQL is `workspace = ?` with the validated workspace, the route requires a
 * workspace (no `*`, no default), and bindRouteTarget rejects a token bound elsewhere. In arcade
 * mode the injected store is the lane-pinned one, which ignores the requested workspace entirely.
 * Codes: 400 workspace_required | outbox_dead_invalid_request, 501 outbox_dead_not_supported.
 */
import type { ServerResponse } from 'node:http';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { bindRouteTarget } from '../../../../security/routeWorkspaceBinding.js';
import { countAudience } from '../../../../security/visibleCounts.js';
import { redactError } from '../../../../security/logRedact.js';
import { keyOfEntry, SUPERSEDED_DEAD_ERROR } from '../../../../outbox/supersession.js';
import { MAX_DEAD_PAGE } from '../../../../outbox/sqliteDeadLetters.js';
import type { OutboxEntry } from '../../../../outbox/types.js';
import { extractWorkspace, writeError, writeJson, writeWorkspaceRequired } from '../../helpers.js';
import type { DiagnosticDeps } from './shared.js';

const DEFAULT_PAGE = 50;

function intParam(raw: string | null, dflt: number): number | null {
    if (raw === null || raw === '') return dflt;
    if (!/^\d{1,9}$/.test(raw)) return null;
    return Number(raw);
}

function reasonOf(e: OutboxEntry): string {
    if (e.deadReason) return e.deadReason;
    return e.lastError === SUPERSEDED_DEAD_ERROR ? 'superseded' : 'unclassified';
}

function rowOf(e: OutboxEntry, includeError: boolean): Record<string, unknown> {
    const k = keyOfEntry(e);
    const nodeId = k?.family === 'node' ? k.key : k?.family === 'verbatim' ? k.key.replace(/^lore:/, '') : undefined;
    return {
        id: e.id,
        operationKind: e.operationKind,
        ...(nodeId !== undefined ? { nodeId } : {}),
        reason: reasonOf(e),
        createdAt: e.createdAt,
        firstTransientAt: e.firstTransientAt ?? null,
        deadAt: e.failedAt ?? e.updatedAt ?? null,
        attempts: e.attempts ?? 0,
        transientRetries: e.transientRetries ?? 0,
        sequenceId: e.sequenceId ?? null,
        ...(includeError ? { lastError: e.lastError ?? null } : {}),
    };
}

export async function handleOutboxDead(res: ServerResponse, url: string, deps: DiagnosticDeps): Promise<void> {
    try {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane ?? null },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return; }

        const u = new URL(url, 'http://x');
        const workspace = extractWorkspace(null, u.searchParams);
        if (!workspace) { writeWorkspaceRequired(res); return; }
        if (workspace === '*') {
            writeError(res, 400, 'outbox_dead_invalid_request', 'dead-letter listing is per workspace; workspace "*" is not allowed');
            return;
        }
        if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return;

        const reqLimit = intParam(u.searchParams.get('limit'), DEFAULT_PAGE);
        const offset = intParam(u.searchParams.get('offset'), 0);
        if (reqLimit === null || offset === null || reqLimit < 1) {
            writeError(res, 400, 'outbox_dead_invalid_request', 'limit must be an integer >= 1 and offset an integer >= 0');
            return;
        }
        const limit = Math.min(reqLimit, MAX_DEAD_PAGE);

        const store = deps.outboxStore;
        if (!store?.listDeadPage || !store.deadLetterSummary) {
            writeError(res, 501, 'outbox_dead_not_supported', 'this outbox store cannot list dead-lettered rows');
            return;
        }
        const summary = await store.deadLetterSummary(workspace);
        const entries = await store.listDeadPage({ workspace, limit, offset });
        const includeError = countAudience() === 'raw';
        const total = summary.deadLettered + summary.deadSuperseded;
        writeJson(res, 200, {
            workspace,
            deadLettered: summary.deadLettered,
            deadSuperseded: summary.deadSuperseded,
            deadByReason: summary.deadByReason,
            total,
            rows: entries.map((e) => rowOf(e, includeError)),
            limit,
            offset,
            hasMore: offset + entries.length < total,
            cap: MAX_DEAD_PAGE,
        });
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}
