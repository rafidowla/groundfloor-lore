/**
 * linkProposals.ts - HTTP surface for the typing proposals of Links Loop D (`supersedes` / `contradicts`).
 *
 *   GET  /api/link-proposals[?workspace=&status=&kind=&limit=&offset=]   list (VIEW: `read`)
 *   GET  /api/link-proposals/:id[?workspace=]                            one proposal (VIEW: `read`)
 *   POST /api/link-proposals/:id/accept   {workspace?, note?}            apply it (ACT: `review`)
 *   POST /api/link-proposals/:id/reject   {workspace?, note?}            decline it (ACT: `review`)
 *
 * Both permissions are workspace-bound (see reviewShared.ts); `write` alone cannot accept or reject. A proposal id is
 * only ever looked up inside the bound workspace, so another workspace's id is a plain 404. The reviewer recorded on
 * the decision is the authenticated principal, never a body field. Absent (404) when LORE_LINK_DISCOVERY is off.
 * Accept goes through the existing supersede path (discoveryAccept.ts); nothing here applies a proposal by itself.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { LinkService } from '../../../link/linkService.js';
import type { ProposalKind, ProposalStatus } from '../../../link/proposalStore.js';
import type { DecideOutcome } from '../../../link/discoveryAccept.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { WorkspaceAccessDeniedError } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';
import { writeError } from '../helpers.js';
import {
    REVIEW_DEFAULT_LIMIT, REVIEW_MAX_LIMIT, actWorkspaceParam, bindReviewWorkspace, intParam, optionalString,
    readReviewBody, reviewerIdentity, writeJson,
} from './reviewShared.js';

export interface LinkProposalsDeps {
    linkService: LinkService | null;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
}

const BASE = '/api/link-proposals';
const STATUSES: ReadonlyArray<ProposalStatus | 'any'> = ['pending', 'accepted', 'rejected', 'stale', 'any'];
const KINDS: ReadonlyArray<ProposalKind> = ['supersedes', 'contradicts'];
const NOTE_MAX = 500;
const OFFSET_MAX = 1_000_000;

type Match = { op: 'list' } | { op: 'get'; id: number } | { op: 'accept' | 'reject'; id: number } | { op: 'bad_id' };

function match(method: string, pathname: string): Match | null {
    if (pathname === BASE) return method === 'GET' ? { op: 'list' } : null;
    if (!pathname.startsWith(`${BASE}/`)) return null;
    const parts = pathname.slice(BASE.length + 1).split('/');
    if (parts.length < 1 || parts.length > 2) return null;
    const action = parts[1];
    if (action !== undefined && action !== 'accept' && action !== 'reject') return null;
    if (action === undefined ? method !== 'GET' : method !== 'POST') return null;
    if (!/^\d{1,15}$/.test(parts[0]!)) return { op: 'bad_id' };
    const id = Number(parts[0]);
    return action === undefined ? { op: 'get', id } : { op: action, id };
}

function decideFailure(res: ServerResponse, out: Extract<DecideOutcome, { ok: false }>): void {
    switch (out.reason) {
        case 'not_found': writeError(res, 404, 'proposal_not_found', 'no such proposal in this workspace'); return;
        case 'not_pending': writeError(res, 409, 'proposal_not_pending', 'proposal was already decided', { status: out.detail }); return;
        case 'workspace_unavailable': writeError(res, 404, 'workspace_unavailable', 'the workspace cannot be opened'); return;
        case 'already_superseded': writeError(res, 409, 'already_superseded', 'the older node is already superseded; the proposal is now stale'); return;
        default: writeError(res, 422, 'supersede_failed', 'the supersede could not be applied', out.detail ? { detail: out.detail.slice(0, 200) } : undefined);
    }
}

export async function tryLinkProposalRoutes(
    req: IncomingMessage, res: ServerResponse, url: string, pathname: string, deps: LinkProposalsDeps,
): Promise<boolean> {
    if (!pathname.startsWith(BASE)) return false;
    const m = match(req.method ?? 'GET', pathname);
    if (!m) return false;
    const act = m.op === 'accept' || m.op === 'reject';
    // Cloud ReBAC has no `review` relation; ACT maps to its `write` permission there. Local mode enforces the real
    // `review` scope in bindReviewWorkspace (gateRoute's local branch would demand `write`, which is not what ACT needs).
    const gate = await gateRoute({ deploymentMode: deps.deploymentMode, dataplane: deps.dataplane }, {
        permission: act && deps.deploymentMode === 'cloud' ? 'write' : 'read',
    });
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
    if (m.op === 'bad_id') { writeError(res, 400, 'invalid_proposal_id', 'proposal id must be a positive integer'); return true; }

    const sp = new URL(url, 'http://x').searchParams;
    // ACT: scope + workspace check BEFORE the body is read, so a token without `review` never makes us parse a body.
    let workspace = bindReviewWorkspace(res, sp.get('workspace') ?? sp.get('project') ?? undefined, act ? 'review' : 'read');
    if (workspace === null) return true;
    let body: Record<string, unknown> = {};
    if (act) {
        const parsed = await readReviewBody(req, res);
        if (parsed === null) return true;
        body = parsed;
        const requested = actWorkspaceParam(res, sp.get('workspace') ?? sp.get('project'), body);
        if (requested === null) return true;
        workspace = bindReviewWorkspace(res, requested.value, 'review');
        if (workspace === null) return true;
    }

    const svc = deps.linkService;
    if (!svc || !svc.hasDiscovery) { writeError(res, 404, 'link_proposals_unavailable', 'link discovery is not enabled on this host'); return true; }

    try {
        if (m.op === 'list') {
            const status = sp.get('status') ?? 'pending';
            const kind = sp.get('kind');
            if (!STATUSES.includes(status as ProposalStatus | 'any')) { writeError(res, 400, 'invalid_status', `'status' must be one of ${STATUSES.join(', ')}`); return true; }
            if (kind !== null && !KINDS.includes(kind as ProposalKind)) { writeError(res, 400, 'invalid_kind', `'kind' must be one of ${KINDS.join(', ')}`); return true; }
            const limit = intParam(res, sp, 'limit', 1, REVIEW_MAX_LIMIT);
            if (limit === null) return true;
            const offset = intParam(res, sp, 'offset', 0, OFFSET_MAX);
            if (offset === null) return true;
            const lim = limit ?? REVIEW_DEFAULT_LIMIT;
            const off = offset ?? 0;
            // One extra row tells us whether another page exists without a COUNT.
            const rows = svc.listProposals(workspace, { status: status as ProposalStatus | 'any', ...(kind ? { kind: kind as ProposalKind } : {}), limit: lim + 1, offset: off });
            const page = rows.slice(0, lim);
            writeJson(res, 200, { workspace, proposals: page, limit: lim, offset: off, nextOffset: rows.length > lim ? off + lim : null });
            return true;
        }
        if (m.op === 'get') {
            const found = svc.getProposal(workspace, m.id);
            if (!found) { writeError(res, 404, 'proposal_not_found', 'no such proposal in this workspace'); return true; }
            writeJson(res, 200, { workspace, proposal: found });
            return true;
        }
        const note = optionalString(res, body, 'note', NOTE_MAX);
        if (note === null) return true;
        const opt = { by: reviewerIdentity(), note: note ?? null };
        const out = m.op === 'accept' ? await svc.acceptProposal(workspace, m.id, opt) : svc.rejectProposal(workspace, m.id, opt);
        if (!out.ok) { decideFailure(res, out); return true; }
        writeJson(res, 200, { workspace, proposal: out.proposal });
    } catch (err) {
        if (err instanceof WorkspaceAccessDeniedError) { writeError(res, 403, 'workspace_forbidden', 'not authorized for the requested workspace'); return true; }
        writeError(res, 500, 'internal_error', redactError(err));
    }
    return true;
}
