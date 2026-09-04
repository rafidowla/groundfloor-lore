/**
 * proposals.ts — schema-proposal routes.
 *
 *   POST /api/schema/proposals                     — propose (body = SchemaProposal)
 *   GET  /api/schema/proposals                     — list pending proposals
 *   GET  /api/schema/proposals/{sandboxId}         — fetch one
 *   POST /api/schema/proposals/{sandboxId}/approve — body = {approver, note?}
 *   POST /api/schema/proposals/{sandboxId}/reject  — body = {reviewer, reason}
 *
 * GAP 1 (2026-08-17, reframed) — a destructive approve is ALWAYS routed
 * through the second-party HITL queue (pendingOpsStore is now mandatory
 * for destructive change kinds, not optional): the queue's explicit,
 * separate `/api/approvals/{id}/decision` call IS the required human-
 * confirmation step. This is deliberately NOT "two different humans must
 * approve" — this product runs for a single operator, so the route no
 * longer compares proposedBy to approver. Additive proposals are
 * unaffected and still execute immediately.
 *
 * GAP 1 (2026-08-17, MCP follow-up) — the mandatory-HITL decision logic
 * moved to `security/schemaApprovalGate.ts` (`gateSchemaApproval`), the
 * ONE chokepoint this route and the `schema_approve` MCP tool
 * (`mcp/phaseATools.ts`) both run through before calling
 * `SchemaAuthoringStore.approve()`.
 */

import type { SchemaProposal } from '../../../../schemas/authoring.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gateSchemaApproval } from '../../../../security/schemaApprovalGate.js';
import { readJsonBody, writeJson, writeError, isInvalidJsonBody, writeInvalidJson } from '../../helpers.js';
import { PREFIX, SCHEMA_APPROVE_OPERATION, type SchemaRoutesDeps } from './shared.js';
import { redactError } from '../../../../security/logRedact.js';
import { getCurrentPrincipal } from '../../../../auth/principal.js';

/**
 * Wave 4.2 — the per-endpoint read/write scope gates (formerly
 * requireProposalWriteScope / requireProposalReadScope, each calling
 * require{Write,Read}FromWorkspace(getCurrentPrincipal(), undefined)) are gone.
 * The family dispatcher (trySchemaRoutes → bindRouteTarget) now binds the
 * request's CONCRETE target with a method-derived intent (POST → write, GET →
 * read) BEFORE any sub-route runs, so:
 *   - a write-only or read-only token is scope-checked with the right intent
 *     and 403'd at the gate (identical outcome to the old per-route deny);
 *   - the target is confirmed to equal the family's wired schemaWorkspace,
 *     else the request is 409'd (schema_workspace_not_active).
 * This removes the literal-undefined targets banned by arch rule D-021 and the
 * raw auth/principal scope-gate imports from this route file.
 */

/** Returns true once a response has been written (owns the /proposals subtree). */
export async function tryProposalRoutes(req: IncomingMessage, res: ServerResponse, deps: SchemaRoutesDeps, pathname: string): Promise<boolean> {
    if (pathname === `${PREFIX}/proposals` && req.method === 'POST') {
        try {
            const proposal = await readJsonBody(req) as SchemaProposal;
            // GAP 1 (2026-08-17) — bind proposedBy to the authenticated principal
            // (same identity mapping as the approve route below), so a forged
            // 'human:*' body field can't be the proposer of a destructive change
            // the caller later self-approves. No principal (legacy/no-auth) →
            // body passthrough.
            const principal = getCurrentPrincipal();
            if (principal?.label) {
                proposal.proposedBy = `${principal.kind === 'bootstrap' ? 'human' : 'system'}:${principal.label}`;
            }
            const sandbox = await deps.phaseA.schemaAuthoring.propose(proposal);
            writeJson(res, 201, {
                sandboxId: sandbox.sandboxId,
                proposedAt: sandbox.proposedAt,
                // Phase 3 item 1 — blast radius rides along when a
                // graph reader is wired (production); absent in tests
                // that didn't pass one.
                ...(sandbox.blastRadius ? { blastRadius: sandbox.blastRadius } : {}),
            });
        } catch (e) {
            // Phase 1 destructive guard messages mention "destructive change";
            // surface them as 403 (forbidden by policy), not 500.
            const msg = (e as Error).message;
            if (isInvalidJsonBody(e)) {
                // X-json400 (2026-09-03 audit) — already 400, but
                // redactError garbled the JSON.parse diagnostic; route
                // through writeInvalidJson for a clean message instead.
                writeInvalidJson(res, e);
            } else if (/destructive change/i.test(msg)) {
                writeError(res, 403, 'destructive_change_requires_human', redactError(e));
            } else {
                writeError(res, 400, 'propose_failed', redactError(e));
            }
        }
        return true;
    }

    if (pathname === `${PREFIX}/proposals` && req.method === 'GET') {
        try {
            writeJson(res, 200, deps.phaseA.schemaAuthoring.listProposals());
        } catch (e) { writeError(res, 500, 'list_proposals_failed', redactError(e)); }
        return true;
    }

    /* /api/schema/proposals/{sandboxId}[ /approve | /reject ] */
    const proposalsPrefix = `${PREFIX}/proposals/`;
    if (pathname.startsWith(proposalsPrefix)) {
        const tail = pathname.slice(proposalsPrefix.length);
        const segments = tail.split('/').filter(Boolean);
        const sandboxId = decodeURIComponent(segments[0] ?? '');
        const action = segments[1];

        if (segments.length === 1 && req.method === 'GET') {
            const entry = deps.phaseA.schemaAuthoring.getProposal(sandboxId);
            if (!entry) {
                writeError(res, 404, 'proposal_not_found', `no proposal '${sandboxId}'`);
                return true;
            }
            writeJson(res, 200, entry);
            return true;
        }

        if (action === 'approve' && req.method === 'POST') {
            try {
                const body = await readJsonBody(req) as { approver?: string; note?: string };
                // 2.4 (2026-08-17) — the approver must be the AUTHENTICATED
                // principal, not a client-supplied string. A forged body.approver
                // (or initiator) would otherwise let one caller approve its own
                // destructive proposal (isHumanProposer only checks the 'human:'
                // prefix). Fall back to body.approver only when NO principal is
                // bound (legacy/no-auth), mirroring approvals.ts handleDecide.
                const principal = getCurrentPrincipal();
                const approver = principal?.label
                    ? `${principal.kind === 'bootstrap' ? 'human' : 'system'}:${principal.label}`
                    : (typeof body.approver === 'string' && body.approver.length > 0 ? body.approver : null);
                if (!approver) {
                    writeError(res, 400, 'invalid_approve_body', 'body must be {approver: string, note?: string}');
                    return true;
                }

                const entry = deps.phaseA.schemaAuthoring.getProposal(sandboxId);
                if (!entry) {
                    writeError(res, 404, 'proposal_not_found', `no proposal '${sandboxId}'`);
                    return true;
                }

                // GAP 1 (2026-08-17, MCP follow-up) — the mandatory-HITL gate
                // now lives in ONE shared chokepoint (schemaApprovalGate.ts)
                // every entry point that approves a schema proposal must run
                // through — this route AND the schema_approve MCP tool. See
                // that module's header for why the gate isn't inside
                // SchemaAuthoringStore.approve() itself.
                const gateOutcome = await gateSchemaApproval({
                    proposal: entry.proposal,
                    sandboxId,
                    approver,
                    note: body.note,
                    workspaceId: deps.schemaWorkspace ?? 'default',
                    pendingOpsStore: deps.pendingOpsStore,
                    runMode: deps.runMode,
                });
                if (gateOutcome.kind === 'refused') {
                    writeError(res, 503, gateOutcome.code, gateOutcome.message);
                    return true;
                }
                if (gateOutcome.kind === 'enqueued') {
                    writeJson(res, 202, {
                        queued: true,
                        pendingOpId: gateOutcome.pendingOp.id,
                        operation: SCHEMA_APPROVE_OPERATION,
                        sandboxId,
                        rationale: gateOutcome.rationale,
                    });
                    return true;
                }

                const receipt = await deps.phaseA.schemaAuthoring.approve(
                    sandboxId, approver, body.note,
                );
                writeJson(res, 200, receipt);
            } catch (e) {
                // X-json400 (2026-09-03 audit) — readJsonBody's tagged parse
                // error never matched /not found/i, so a malformed body fell
                // through to a 500 approve_failed. Check the tag first.
                if (isInvalidJsonBody(e)) { writeInvalidJson(res, e); return true; }
                const msg = (e as Error).message;
                const status = /not found/i.test(msg) ? 404 : 500;
                writeError(res, status, 'approve_failed', redactError(e));
            }
            return true;
        }

        if (action === 'reject' && req.method === 'POST') {
            try {
                const body = await readJsonBody(req) as { reviewer?: string; reason?: string };
                if (!body?.reviewer || !body?.reason) {
                    writeError(res, 400, 'invalid_reject_body', 'body must be {reviewer: string, reason: string}');
                    return true;
                }
                const rec = deps.phaseA.schemaAuthoring.reject(
                    sandboxId, body.reviewer, body.reason,
                );
                writeJson(res, 200, rec);
            } catch (e) {
                // X-json400 (2026-09-03 audit) — see the approve handler above.
                if (isInvalidJsonBody(e)) { writeInvalidJson(res, e); return true; }
                const msg = (e as Error).message;
                const status = /not found/i.test(msg) ? 404 : 500;
                writeError(res, status, 'reject_failed', redactError(e));
            }
            return true;
        }

        writeError(res, 405, 'method_not_allowed',
            `method ${req.method} not allowed on ${pathname}`);
        return true;
    }

    return false;
}
