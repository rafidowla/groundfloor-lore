/**
 * approvalEnforcer.ts — One helper every gated route/tool calls
 * before executing its real handler.
 *
 * `decideApproval` (in humanApproval.ts) is pure — it tells you what
 * to do but doesn't do it. The pending-ops queue is the persistence
 * layer but doesn't know about policies. This module is the glue:
 * given a policy + the caller's args + the queue + the actor, return
 * one of three actionable outcomes the route handler turns into HTTP
 * (or MCP tool response):
 *
 *   'execute'         caller is allowed to run the real handler now
 *   'self-confirm'    400 with the canonical error envelope
 *   'enqueued'        202 with the new approval id
 *
 * Pure-function shape (no HTTP types, no Express coupling) so it
 * works for both the HTTP routes and the MCP tool wrapper.
 */

import {
    decideApproval,
    formatSelfConfirmError,
    type HumanApprovalPolicy,
} from './humanApproval.js';
import type { PendingOp, PendingOpsStore } from './pendingOps.js';

export interface EnforceApprovalInput<TArgs = unknown> {
    /** Name of the op being gated (e.g. 'forget_person'). Used in
     *  error envelopes and the enqueued row. */
    operation: string;
    /** The declarative tier metadata for this op. */
    policy: HumanApprovalPolicy;
    /** Args envelope from the caller (looked up for the confirm token). */
    args: TArgs;
    /** Workspace this op acts on. Matches the pending-op row scope. */
    workspaceId: string;
    /** Initiator's identity (portal_user id). */
    initiator: string;
    /** Pending-ops queue — only consulted on the second-party path. */
    pendingOpsStore: PendingOpsStore;
    /** Optional override for the confirm-token field name. */
    confirmField?: string;
}

export type EnforceApprovalOutcome =
    | { kind: 'execute' }
    | {
        kind: 'self-confirm-required';
        /** Already-formatted error envelope. Caller returns it verbatim
         *  (HTTP 400) or wraps for MCP. */
        error: ReturnType<typeof formatSelfConfirmError>;
    }
    | {
        kind: 'enqueued';
        /** The new pending-op row. Caller returns HTTP 202 with this. */
        pendingOp: PendingOp;
    };

/**
 * Apply the policy. Does NOT execute the real handler — only decides
 * what should happen next. On the second-party path, this DOES write
 * to the queue (returns the new pending-op row).
 */
export async function enforceApproval<TArgs = unknown>(
    input: EnforceApprovalInput<TArgs>,
): Promise<EnforceApprovalOutcome> {
    const decision = decideApproval({
        policy: input.policy,
        args: input.args,
        confirmField: input.confirmField,
    });

    switch (decision.kind) {
        case 'execute':
            return { kind: 'execute' };

        case 'needs-self-confirm':
            return {
                kind: 'self-confirm-required',
                error: formatSelfConfirmError(input.operation, decision, input.policy.rationale),
            };

        case 'enqueue': {
            const pendingOp = await input.pendingOpsStore.enqueue({
                operation: input.operation,
                workspaceId: input.workspaceId,
                initiator: input.initiator,
                args: input.args,
                enqueueRationale: input.policy.rationale,
                // L-029 — persist the approver permission decideApproval computed
                // so the decision endpoint can enforce the correct gate. `decision`
                // is narrowed to the 'enqueue' variant here, so this is typed.
                approverPermission: decision.approverPermission,
            });
            return { kind: 'enqueued', pendingOp };
        }
    }
}
