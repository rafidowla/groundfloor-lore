/**
 * schemaApprovalGate.ts — the ONE mandatory-HITL gate every entry point
 * that approves a schema proposal must run through before calling
 * `SchemaAuthoringStore.approve()` directly.
 *
 * GAP 1 (2026-08-17, MCP follow-up). The HTTP route
 * (`mcp/http/routes/schema/proposals.ts`) and the MCP tool
 * (`mcp/phaseATools.ts`'s `schema_approve`) both call
 * `SchemaAuthoringStore.approve()` on the SAME underlying store — but
 * only the HTTP route was gated the first time this remediation ran
 * (commit 71e0607). That's the second time a caller of `.approve()` went
 * unprotected because the gate lived inline at one call site instead of
 * a shared chokepoint. This module IS the chokepoint: every current and
 * future caller imports `gateSchemaApproval` and runs it before touching
 * `SchemaAuthoringStore.approve()`.
 *
 * Why this isn't inside `SchemaAuthoringStore.approve()` itself: that
 * method is also the ACTUAL EXECUTION step the second-party HITL replay
 * handler calls (`schemas/orchestration/wiring.ts`'s `schema_approve`
 * replay handler) once a human has already decided the pending op via
 * `POST /api/approvals/{id}/decision`. Gating `.approve()` itself would
 * need a bypass token threaded through that already-verified replay path
 * — risking exactly the kind of regression the ground rules for this
 * remediation forbid ("do not touch or weaken the already-verified
 * HTTP-route fix"). A shared pre-call gate every ENTRY POINT is forced
 * through gets the same one-chokepoint guarantee without touching the
 * execution/replay side.
 *
 * Contract: destructive proposals are refused unless a `pendingOpsStore`
 * is wired; when wired, the change is unconditionally enqueued (the
 * `enqueue` decision is the ONLY thing `second-party` tier ever returns)
 * and the caller must NOT call `.approve()` — the real human-confirmation
 * step is the separate, later `POST /api/approvals/{id}/decision` call.
 * Additive proposals are unaffected (`kind: 'proceed'`).
 *
 * ITEM 3 (launch-fixes-2026-08) — EMBEDDED run mode refuses destructive
 * proposals AT PROPOSAL TIME, even with the queue wired. Embedded opens
 * no HTTP transport (W3-EMBEDDED-MODE), so the confirmation endpoint
 * above can never be reached: an enqueued op would sit pending forever
 * — the v3.14.0 CHANGELOG "Known limitation" hang (see
 * docs/DEPLOYMENT_MODEL.md's `embedded` row). server.ts wires
 * `pendingOpsStore` UNCONDITIONALLY, so the queue-presence check below
 * alone can never fire for embedded; the run-mode check must come FIRST.
 * Refusing honestly beats enqueueing an undecidable op: the caller
 * learns immediately that daemon (local) mode is required, and nothing
 * leaks into the queue. The full embedded confirm path is deferred
 * post-launch (BACKLOG-launch-readiness-2026-08-19.md, item 3).
 */

import type { SchemaProposal } from '../schemas/authoring.js';
import { hasDestructiveChange } from '../schemas/destructive.js';
import { enforceApproval } from './approvalEnforcer.js';
import type { HumanApprovalPolicy } from './humanApproval.js';
import type { PendingOp, PendingOpsStore } from './pendingOps.js';

/** Operation key used in the pending-ops queue + replay registry for
 *  schema approves that get routed through the second-party HITL queue. */
export const SCHEMA_APPROVE_OPERATION = 'schema_approve';

export interface SchemaApprovalGateInput {
    proposal: SchemaProposal;
    sandboxId: string;
    approver: string;
    note?: string;
    /** The boot-bound schema workspace (HTTP: `deps.schemaWorkspace`; MCP:
     *  `deps.detectedScope.workspace`) — tags the enqueued pending-op row. */
    workspaceId: string;
    pendingOpsStore: PendingOpsStore | undefined;
    /**
     * The instance's full run mode (the same four-way choice as
     * `LoreDeploymentMode` in mcp/server.ts — redeclared inline here so
     * this security chokepoint does not import the server module:
     * server.ts → createMcpServer.ts → phaseATools.ts → THIS file would
     * become an import cycle). Optional ONLY so pre-existing harnesses
     * that never exercise embedded mode keep compiling; BOTH production
     * call sites (the /api/schema proposals route and the schema_approve
     * MCP tool) wire it. `undefined` preserves the pre-item-3 behavior
     * (queue presence alone decides), which is correct for every daemon
     * mode — 'embedded' is the only mode where a wired queue is still
     * undecidable.
     */
    runMode?: 'local' | 'cloud' | 'embedded' | 'arcade';
}

export type SchemaApprovalGateOutcome =
    /** Additive, or nothing further required — caller proceeds to call
     *  `SchemaAuthoringStore.approve()` itself. */
    | { kind: 'proceed' }
    /** Destructive + queue wired — enqueued. Caller must NOT call
     *  `.approve()`; return the pending-op info to the caller. */
    | { kind: 'enqueued'; pendingOp: PendingOp; rationale: string }
    /** Destructive + no human-confirmation step reachable — refused.
     *  Two triggers: no queue wired at all
     *  (`destructive_hitl_unavailable`), or embedded run mode where the
     *  HTTP-only confirmation endpoint can never be called
     *  (`destructive_hitl_unavailable_embedded`). */
    | { kind: 'refused'; code: string; message: string };

/**
 * Run the mandatory-HITL gate for a schema-approve attempt. Every caller
 * MUST call this before `SchemaAuthoringStore.approve()` and act on the
 * outcome — `'proceed'` is the only outcome that permits calling
 * `.approve()` directly.
 */
export async function gateSchemaApproval(
    input: SchemaApprovalGateInput,
): Promise<SchemaApprovalGateOutcome> {
    const destructive = hasDestructiveChange(input.proposal);
    if (!destructive) return { kind: 'proceed' };

    // ITEM 3 (launch-fixes-2026-08) — embedded run mode has no HTTP
    // transport, so the mandatory confirmation step (POST
    // /api/approvals/{id}/decision) can never be reached and any enqueued
    // op would hang pending forever. Refuse BEFORE the queue-presence
    // check: server.ts wires pendingOpsStore unconditionally, so without
    // this branch embedded always took the enqueue path — the v3.14.0
    // known-limitation hang. Daemon modes never reach this branch.
    if (input.runMode === 'embedded') {
        return {
            kind: 'refused',
            code: 'destructive_hitl_unavailable_embedded',
            message: 'destructive schema changes require daemon (local) mode: the mandatory human-confirmation ' +
                'step (POST /api/approvals/{id}/decision) is HTTP-only and embedded mode opens no transport, ' +
                'so an enqueued change could never be confirmed. Run the local daemon (`lore serve --http`) ' +
                'and approve via the approvals endpoint instead.',
        };
    }

    if (!input.pendingOpsStore) {
        return {
            kind: 'refused',
            code: 'destructive_hitl_unavailable',
            message: 'destructive schema changes require a human-confirmation step via the second-party ' +
                'HITL queue (POST /api/approvals/{id}/decision), which is not wired in this deployment',
        };
    }

    const rationale =
        'Destructive schema change — requires an explicit human-confirmation step (POST /api/approvals/{id}/decision) before it is applied to the live schema.';
    const policy: HumanApprovalPolicy = {
        tier: 'second-party',
        rationale,
        approverPermission: 'administer',
    };
    const outcome = await enforceApproval({
        operation: SCHEMA_APPROVE_OPERATION,
        policy,
        args: { sandboxId: input.sandboxId, approver: input.approver, note: input.note },
        workspaceId: input.workspaceId,
        // Deliberately NOT the approver's identity — see proposals.ts's own
        // comment for why the pendingOps self-approval-forbidden invariant
        // (initiator === decidedBy) does not apply to this flow. A stable
        // per-proposal sentinel can never collide with a real decider
        // identity, so a single operator can complete propose -> approve ->
        // decide alone.
        initiator: `schema-approve:${input.sandboxId}`,
        pendingOpsStore: input.pendingOpsStore,
    });
    if (outcome.kind === 'enqueued') {
        return { kind: 'enqueued', pendingOp: outcome.pendingOp, rationale };
    }
    // Tier-3 only ever decides 'enqueue'; the other branches are defensive.
    return { kind: 'proceed' };
}
