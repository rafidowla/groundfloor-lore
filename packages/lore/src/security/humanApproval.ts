/**
 * humanApproval.ts — Three-tier approval policy for Lore operations.
 *
 * Per AUTH_AND_SYNC_DESIGN.md (2026-05-10), every MCP tool and HTTP
 * route gets one of three approval tiers:
 *
 *   automated      Runs without human input. Most reads, additive
 *                  writes, store_node.
 *   self-confirm   Initiator includes `confirm: true` in the request.
 *                  Same actor confirms their own action — an "are you
 *                  sure" gate, not real HITL. Examples: forget_person,
 *                  drop schema, orphan resolve.
 *   second-party   A *different* human with `administer` on the same
 *                  workspace must approve before execution. Op enters
 *                  the pending-approvals queue; original caller gets
 *                  back a 202 + approval id.
 *
 * Today only `automated` and `self-confirm` are realized in code (we
 * already had inline `confirm: true` checks). This module formalizes
 * the metadata so the tier is declarative, surfaceable in docs / admin
 * UI / audit log, and `second-party` enforcement can land alongside
 * the queue + decision endpoints (see pendingOps.ts).
 *
 * Design notes:
 *  - The tier is a property of the *operation*, not of the request.
 *    A given tool/route always has one tier; the request can't choose
 *    a different one.
 *  - `automated` operations may STILL be authz-gated by ReBAC. The
 *    tier is orthogonal to the permission check — `automated` means
 *    "no human-approval step beyond the permission check," not "no
 *    auth required."
 *  - Tier 3 (`second-party`) requires the queue to be live. When the
 *    queue is unavailable (e.g. cold cloud bootstrap), tools tagged
 *    `second-party` should fail closed (refuse to execute) rather
 *    than silently degrade to `automated`.
 */

/** The three approval tiers. */
export type HumanApprovalTier =
    | 'automated'
    | 'self-confirm'
    | 'second-party';

/**
 * Declarative metadata attached to each tool/route. Keep small and
 * stable — this is consumed by docs, admin UI, audit log, and the
 * runtime decision in `decideApproval`.
 */
export interface HumanApprovalPolicy {
    /** Required tier for this operation. */
    tier: HumanApprovalTier;
    /**
     * Human-readable reason for the tier choice. Surfaced in the
     * approval queue UI, audit log, and refusal messages so the user
     * understands why their op is gated. Optional for `automated`,
     * required for `self-confirm` + `second-party`.
     */
    rationale?: string;
    /**
     * For `self-confirm`: the literal string the caller must include
     * to confirm. Defaults to the boolean `true`. Existing patterns:
     *   forget_person   → confirm: true  (boolean)
     *   orphan-drop     → confirm: 'DROP' (string literal)
     *   operator clear  → --confirm flag (CLI)
     */
    confirmToken?: true | string;
    /**
     * For `second-party`: the permission an approver must hold to
     * decide on this op. Defaults to 'administer' on the same
     * workspace. Set narrower (e.g. 'manage_members') only when the
     * op's surface justifies it.
     */
    approverPermission?: 'administer' | 'manage_members';
}

/** Input shape for runtime tier resolution. */
export interface ApprovalInput<TArgs = unknown> {
    /** The op's declared policy. */
    policy: HumanApprovalPolicy;
    /** The full args envelope from the caller. Used to look up confirmToken. */
    args: TArgs;
    /**
     * Optional name of the field that carries the confirm token in
     * `args`. Defaults to `'confirm'` to match the existing pattern.
     */
    confirmField?: string;
}

/** Outcome of `decideApproval`. */
export type ApprovalDecision =
    | { kind: 'execute' }
    /** Caller must include the confirm token. Returned by `decideApproval`
     *  with the expected token so the route handler can format an error
     *  pointing at the right field. */
    | { kind: 'needs-self-confirm'; expectedToken: true | string; field: string }
    /** Op should be enqueued for second-party approval. */
    | { kind: 'enqueue'; approverPermission: 'administer' | 'manage_members' };

/**
 * Decide whether to execute, request a self-confirm, or enqueue.
 * Pure function — no side effects. Route handler executes the
 * decision (calls execute, returns 400 with confirm-required, or
 * calls the queue's enqueue helper).
 */
export function decideApproval<TArgs = unknown>(
    input: ApprovalInput<TArgs>,
): ApprovalDecision {
    const { policy, args } = input;
    const field = input.confirmField ?? 'confirm';

    switch (policy.tier) {
        case 'automated':
            return { kind: 'execute' };

        case 'self-confirm': {
            const expected = policy.confirmToken ?? true;
            const presented = (args as Record<string, unknown>)?.[field];
            const ok = expected === true
                ? presented === true
                : presented === expected;
            if (ok) return { kind: 'execute' };
            return { kind: 'needs-self-confirm', expectedToken: expected, field };
        }

        case 'second-party':
            return {
                kind: 'enqueue',
                approverPermission: policy.approverPermission ?? 'administer',
            };
    }
}

/**
 * Format the standard error envelope when self-confirm is missing.
 * Matches the shape `forget_person` and orphan-drop already use, so
 * existing clients keep working when their tool is migrated to
 * declarative tier metadata.
 */
export function formatSelfConfirmError(
    operation: string,
    decision: Extract<ApprovalDecision, { kind: 'needs-self-confirm' }>,
    rationale?: string,
): { code: 'self_confirm_required'; operation: string; field: string; expected: true | string; message: string } {
    const expectedDesc = decision.expectedToken === true
        ? '`true` (boolean)'
        : `the literal '${decision.expectedToken}'`;
    const reason = rationale ? ` Reason: ${rationale}` : '';
    return {
        code: 'self_confirm_required',
        operation,
        field: decision.field,
        expected: decision.expectedToken,
        message: `${operation} requires self-confirmation. Pass ${decision.field}=${expectedDesc} to acknowledge the destructive operation.${reason}`,
    };
}
