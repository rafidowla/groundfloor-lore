/**
 * approvals.ts — HITL second-party approval queue endpoints.
 *
 *   GET  /api/approvals?status=&workspaceId=&initiator=&limit=
 *        → { approvals: PendingOp[] }
 *   GET  /api/approvals/{id}
 *        → PendingOp | 404
 *   POST /api/approvals/{id}/decision
 *        body: { decision: 'approved'|'rejected', reason?: string, decidedBy?: string }
 *        → updated PendingOp | 4xx
 *
 * decidedBy resolution: the actor context (Clerk JWT subject in cloud
 * mode) wins; otherwise the body must supply `decidedBy` (local mode
 * where there's no actor context). The store enforces
 * `decidedBy !== initiator` so accidentally re-using the operator
 * id from local mode trips the right error.
 *
 * Per CLAUDE.md, route family files stay small + handler logic is
 * extracted into pure functions (the `handle*` helpers) so unit tests
 * can drive them without spinning up Node's http stack.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import { readJsonBody, writeError, writeJson } from '../helpers.js';
import {
    type PendingOp,
    type PendingOpsStore,
    type PendingOpStatus,
    PendingOpNotFoundError,
    PendingOpStaleError,
    SelfApprovalForbiddenError,
} from '../../../security/pendingOps.js';
import {
    replayApprovedOp,
    type ReplayHandlerRegistry,
} from '../../../security/approvalReplay.js';
import { getCurrentActor } from '../../../security/actorContext.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import {
    getCurrentPrincipal,
    type Principal,
} from '../../../auth/principal.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';

// F-R25 — cap on the client-supplied `reason` echoed back into responses
// so an attacker cannot stuff an unbounded blob into the approval record.
const MAX_REASON_LEN = 2000;

export interface ApprovalsDeps {
    /** Getter — store may be re-bound at boot or on workspace switch. */
    getPendingOpsStore: () => PendingOpsStore;
    /** Optional replay registry. When provided, approve-decisions trigger
     *  immediate replay + markExecuted. When omitted, ops only flip to
     *  'approved' and a separate worker / call advances them. */
    getReplayRegistry?: () => ReplayHandlerRegistry | null;
    /** L-010 — deployment mode drives the ReBAC gate's local short-circuit. */
    deploymentMode: 'local' | 'cloud';
    /** L-010 — cloud Dataplane SDK handle for the ReBAC check; null in local. */
    dataplane: GroundfloorClient | null;
}

export type ListResponse = { approvals: PendingOp[] };

export type DecisionBody = {
    decision?: unknown;
    reason?: unknown;
    decidedBy?: unknown;
};

export type HandlerResult =
    | { status: number; body: unknown };

/**
 * Pure handler for `GET /api/approvals` — translates query params
 * into a `list()` call. Status values not in the enum are rejected
 * with 400 so an obvious typo surfaces fast instead of returning the
 * whole queue.
 */
export async function handleList(
    store: PendingOpsStore,
    query: URLSearchParams,
    // L-011 — the route forces this for a bound principal lacking
    // cross-workspace-read so an omitted ?workspaceId can't leak the
    // whole cross-tenant queue. Defaults to the query value so existing
    // pure-handler tests (which pass no third arg) are unchanged.
    scopedWorkspaceId: string | undefined = query.get('workspaceId') ?? undefined,
    // F-R24 — when supplied, the returned rows are filtered to the workspaces
    // this principal is entitled to read. A null principal (local/legacy/no-auth)
    // is left unfiltered. A principal holding cross-workspace-read or
    // cross-workspace-write is an admin and also sees everything.
    principal: Principal | null = null,
): Promise<HandlerResult> {
    const statusParam = query.get('status');
    if (statusParam && !isValidStatus(statusParam)) {
        return { status: 400, body: { code: 'invalid_status', message: `unknown status: ${statusParam}` } };
    }
    const limitParam = query.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        return { status: 400, body: { code: 'invalid_limit', message: `limit must be a positive number` } };
    }
    const approvals = await store.list({
        status: statusParam ? (statusParam as PendingOpStatus) : undefined,
        workspaceId: scopedWorkspaceId,
        initiator: query.get('initiator') ?? undefined,
        limit,
    });
    // F-R24 — defense-in-depth: filter the returned rows to the workspaces this
    // principal may read. A bound principal WITHOUT a cross-workspace-* scope
    // only sees its own workspace (plus any explicit allowedWorkspaces). Null
    // principal = local/legacy bypass; cross-workspace scope = admin (all rows).
    const scoped = scopeApprovalsToPrincipal(approvals, principal);
    return { status: 200, body: { approvals: scoped } satisfies ListResponse };
}

/** Pure handler for `GET /api/approvals/{id}`. */
export async function handleGetById(
    store: PendingOpsStore,
    id: string,
): Promise<HandlerResult> {
    const row = await store.getById(id);
    if (!row) return { status: 404, body: { code: 'not_found', message: `pending op not found: ${id}` } };
    return { status: 200, body: row };
}

/**
 * `replay` field on a successful decide response:
 *   { status: 'skipped' }            — decision was 'rejected', or no registry
 *   { status: 'executed' }           — replay ran + the row was advanced to 'executed'
 *   { status: 'no-handler', operation } — programming error; row stays at 'approved'
 *   { status: 'failed', error }      — handler threw; row stays at 'approved' for retry
 */
export type ReplayOutcome =
    | { status: 'skipped' }
    | { status: 'executed' }
    | { status: 'no-handler'; operation: string }
    | { status: 'failed'; error: string };

export interface DecideResponseBody {
    approval: PendingOp;
    replay: ReplayOutcome;
}

/**
 * Pure handler for `POST /api/approvals/{id}/decision`. `actorPortalUserId`
 * comes from the actor context in cloud mode; in local mode it's null
 * and the body must supply `decidedBy`. Maps store errors to HTTP codes:
 *   PendingOpNotFoundError       → 404 not_found
 *   SelfApprovalForbiddenError   → 403 self_approval_forbidden
 *   PendingOpStaleError          → 409 op_stale
 *
 * On `decision: 'approved'` + a non-null replay registry, the matching
 * handler is invoked immediately and the row is advanced to 'executed'
 * on success. Replay outcome is surfaced in the response so the caller
 * (approval UI) can show what actually happened.
 */
export async function handleDecide(
    store: PendingOpsStore,
    id: string,
    body: DecisionBody,
    actorPortalUserId: string | null,
    registry: ReplayHandlerRegistry | null = null,
    principalLabel: string | null = null,
): Promise<HandlerResult> {
    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
        return { status: 400, body: { code: 'invalid_decision', message: `decision must be 'approved' or 'rejected'` } };
    }
    // F-B1 — derive the decider from the AUTHENTICATED identity, never a
    // client-supplied field when a principal is bound. Cloud actor (Clerk
    // subject) wins; else the bound principal label; only when there is NO
    // principal at all (local/legacy/no-auth) do we accept body.decidedBy. This
    // stops a single caller from approving its own pending op by supplying an
    // arbitrary decidedBy — the store's initiator!==decidedBy guard then blocks
    // self-approval, while a different operator approving is still allowed.
    const decidedBy = actorPortalUserId
        ?? principalLabel
        ?? (typeof body.decidedBy === 'string' && body.decidedBy.length > 0 ? body.decidedBy : null);
    if (!decidedBy) {
        return { status: 401, body: { code: 'missing_decider', message: 'no actor context and no decidedBy in body' } };
    }
    // F-R25 — cap the accepted/echoed reason length to bound storage + response.
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, MAX_REASON_LEN) : undefined;

    let updated: PendingOp;
    try {
        updated = await store.decide({ id, decision, decidedBy, reason });
    } catch (err) {
        if (err instanceof PendingOpNotFoundError) {
            return { status: 404, body: { code: 'not_found', message: err.message } };
        }
        if (err instanceof SelfApprovalForbiddenError) {
            return { status: 403, body: { code: 'self_approval_forbidden', message: err.message } };
        }
        if (err instanceof PendingOpStaleError) {
            return { status: 409, body: { code: 'op_stale', message: err.message, currentStatus: err.currentStatus } };
        }
        throw err;
    }

    // Rejected, or no registry to dispatch through — return the row as-is.
    if (decision === 'rejected' || !registry) {
        const out: DecideResponseBody = { approval: updated, replay: { status: 'skipped' } };
        return { status: 200, body: out };
    }

    const replayResult = await replayApprovedOp(updated, registry);
    if (replayResult.kind === 'executed') {
        // Advance the row past 'approved'. If markExecuted throws (e.g.
        // a race made it stale), surface the row at 'approved' with a
        // failed-replay marker so the approver can investigate.
        try {
            const executed = await store.markExecuted(updated.id);
            const out: DecideResponseBody = { approval: executed, replay: { status: 'executed' } };
            return { status: 200, body: out };
        } catch (e) {
            // F-R25 — redact raw error text before echoing to the client.
            const out: DecideResponseBody = {
                approval: updated,
                replay: { status: 'failed', error: `markExecuted failed: ${redactError(e)}` },
            };
            return { status: 200, body: out };
        }
    }
    if (replayResult.kind === 'no-handler') {
        const out: DecideResponseBody = {
            approval: updated,
            replay: { status: 'no-handler', operation: replayResult.operation },
        };
        return { status: 200, body: out };
    }
    // F-R25 — redact the replay handler's raw error text before echoing.
    const out: DecideResponseBody = {
        approval: updated,
        replay: { status: 'failed', error: redactError(replayResult.error) },
    };
    return { status: 200, body: out };
}

/**
 * F-R24 — restrict a list of pending ops to the workspaces a principal may
 * read. Null principal = unfiltered (local/legacy). A principal holding either
 * cross-workspace scope is an admin and sees all rows. Otherwise rows are kept
 * only when their `workspaceId` is the principal's bound workspace or appears in
 * its explicit `allowedWorkspaces`.
 */
function scopeApprovalsToPrincipal(
    approvals: PendingOp[],
    principal: Principal | null,
): PendingOp[] {
    if (!principal) return approvals;
    if (
        principal.scopes.includes('cross-workspace-read') ||
        principal.scopes.includes('cross-workspace-write')
    ) {
        return approvals;
    }
    const allowed = new Set<string>([principal.workspace, ...(principal.allowedWorkspaces ?? [])]);
    return approvals.filter((op) => allowed.has(op.workspaceId));
}

function isValidStatus(s: string): s is PendingOpStatus {
    return s === 'pending' || s === 'approved' || s === 'rejected'
        || s === 'executed' || s === 'expired';
}

/**
 * Dispatch wrapper. Returns true when the request is in this family,
 * false to let the dispatcher continue. Error responses on parse /
 * unexpected throws use the same envelope as helpers.writeError.
 */
export async function tryApprovalsRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: ApprovalsDeps,
): Promise<boolean> {
    if (pathname === '/api/approvals' && req.method === 'GET') {
        try {
            const parsed = new URL(url, 'http://localhost');
            // L-011 — workspace is an AUTHORIZATION boundary, not just a
            // filter. Gate the requested workspaceId on read scope, and for
            // a bound principal lacking cross-workspace-read FORCE the filter
            // to its own workspace so an omitted workspaceId can't leak the
            // whole cross-tenant queue. Null principal = legacy/local bypass.
            const requestedWorkspace = parsed.searchParams.get('workspaceId') ?? undefined;
            const principal = getCurrentPrincipal();
            if (requestedWorkspace !== undefined) {
                // A specific workspace was requested — bind/scope-check it.
                if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'read' }) === null) return true;
            }
            const effectiveWorkspaceId = principal && !principal.scopes.includes('cross-workspace-read')
                ? principal.workspace
                : requestedWorkspace;
            // F-R24 — pass the principal so returned rows are filtered to the
            // workspaces it may read (defense-in-depth beyond effectiveWorkspaceId).
            const r = await handleList(
                deps.getPendingOpsStore(), parsed.searchParams, effectiveWorkspaceId, principal,
            );
            writeJson(res, r.status, r.body);
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err)); // F-R25
        }
        return true;
    }
    const idMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (idMatch && req.method === 'GET') {
        try {
            // L-011 — fetch first, then gate on the ROW's own workspace so a
            // bound principal cannot read another tenant's op by id.
            const store = deps.getPendingOpsStore();
            const op = await store.getById(idMatch[1]);
            if (!op) { writeJson(res, 404, { code: 'not_found', message: `pending op not found: ${idMatch[1]}` }); return true; }
            if (bindRouteTarget(res, { requested: op.workspaceId, intent: 'read' }) === null) return true;
            writeJson(res, 200, op);
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err)); // F-R25
        }
        return true;
    }
    const decisionMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (decisionMatch && req.method === 'POST') {
        try {
            // L-010 — the decision endpoint triggers replay (real destructive
            // op execution), so it must be authorized like every other write
            // route. Fetch the op once to learn its workspace, then run the
            // ReBAC administer gate (cloud only) + the token-scoped write gate
            // against the OP's own workspace. Null principal = legacy bypass.
            const store = deps.getPendingOpsStore();
            const op = await store.getById(decisionMatch[1]);
            if (!op) { writeJson(res, 404, { code: 'not_found', message: `pending op not found: ${decisionMatch[1]}` }); return true; }
            // L-029 — consume the persisted approver-permission so an op that
            // demanded a stronger gate (e.g. 'manage_members') is enforced at
            // the decision point, not silently downgraded to 'administer'.
            const gate = await gateRoute(
                { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
                { permission: op.approverPermission ?? 'administer' },
            );
            if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
            if (bindRouteTarget(res, { requested: op.workspaceId, intent: 'write' }) === null) return true;
            const principal = getCurrentPrincipal();
            const body = (await readJsonBody(req)) as DecisionBody;
            const actor = getCurrentActor()?.portalUserId ?? null;
            const registry = deps.getReplayRegistry?.() ?? null;
            const r = await handleDecide(
                store, decisionMatch[1], body ?? {}, actor, registry,
                // FIX 6 (launch-fixes-2026-08) — F-B1's own comment above already
                // says the intent is "bind the decider to the authenticated
                // principal", but it passed the bare `principal.label` ("bootstrap"
                // for the default local operator token, with no `human:` prefix).
                // schemas/orchestration/wiring.ts's schema_approve replay handler
                // requires `decidedBy` to start with "human:" (AI/automated actors
                // are refused there by design) — so a local operator's decide call
                // returned 200/202 and the decision was recorded, but the replay
                // threw internally and the destructive change never applied. No
                // caller surface reported this; it silently orphaned the approved
                // op. Mirror the SAME identity-stamping this codebase already uses
                // at the two other places a principal becomes a `decidedBy`/
                // `approver`/`proposedBy` string (mcp/http/routes/schema/
                // proposals.ts propose + approve, mcp/phaseATools.ts's
                // schema_approve tool): `kind === 'bootstrap'` is the local
                // daemon's own operator token — there is no automated/system path
                // that authenticates as `bootstrap` (service callers use `app` /
                // `shared-secret`, per routeWorkspaceBinding.ts) — so a bootstrap
                // principal IS the human operator this decision endpoint exists to
                // require, and any other principal kind is stamped `system:` (kept
                // OUT of `human:*`, preserving the AI/automated-actor refusal).
                // This does NOT weaken self-approval: `security/storeNodeGates.ts`
                // stamps its own store_node HITL `initiator` the SAME way, so an
                // `initiator`/`decidedBy` comparison for the SAME operator still
                // collides correctly (see that file's own comment).
                principal?.label ? `${principal.kind === 'bootstrap' ? 'human' : 'system'}:${principal.label}` : null,
            );
            writeJson(res, r.status, r.body);
        } catch (err) {
            writeError(res, 400, 'bad_request', redactError(err)); // F-R25
        }
        return true;
    }
    return false;
}
