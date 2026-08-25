/**
 * storeNodeGates.ts — Phase 6 P2 gates for POST /api/node.
 *
 * Two checks that run before the route's upsertNode:
 *
 *   1. Strict additionalProperties:false — unknown fields in the body
 *      return 400 unknown_field with a "Did you mean" hint pulled from
 *      `closestField()` (recognises legacy aliases like
 *      `project` → `workspace`).
 *
 *   2. Workspace vocab policy — looks up the per-workspace
 *      `vocabPolicy` and routes by `onMismatch`: reject → 400,
 *      hitl → 202 (after enqueueing into PendingOpsStore), warn →
 *      accept and carry the warning text out so the caller's success
 *      response can attach the `X-Lore-Type-Warning` header.
 *
 * The helpers WRITE the HTTP response on a terminal verdict and return
 * `{ handled: true }`; non-terminal verdicts (accept, warn) return
 * `{ handled: false, typeWarning? }` and the caller proceeds.
 *
 * The route still owns the upsertNode + verbatim writes; only the
 * gating is here. Same shape can be reused by future routes (edge,
 * delete) that need the same contract.
 */

import type { ServerResponse } from 'node:http';
import { writeError } from '../helpers.js';
import {
    STORE_NODE_KNOWN_FIELDS,
    checkUnknownFields,
    checkVocab,
} from '../../../engines/vocabPolicy.js';
import { getWorkspaceVocabPolicy } from '../../../config/workspaces.js';
import type { WorkspaceVocabPolicy } from '../../../config/workspaces.js';
import type { PendingOpsStore } from '../../../security/pendingOps.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';

export interface GateDeps {
    pendingOpsStore?: PendingOpsStore;
    coreNodeTypes?: ReadonlyArray<string>;
    activeWorkspace: string;
    /**
     * Arcade-mode SEAM (Slice-4). When present, vocab-policy lookup goes
     * through this closure instead of `getWorkspaceVocabPolicy`, so an arcade
     * cell (a registry row, NOT a workspaces.json entry) resolves its policy
     * from the relational-lane `cell_policies` table. Absent → local behavior
     * is byte-identical (falls back to getWorkspaceVocabPolicy). This closes
     * the structural policy bypass: today getWorkspaceVocabPolicy throws
     * "Unknown workspace <appId>" for every cell write, and the catch below
     * default-accepts — a silent bypass. With the seam wired, the arcade
     * lookup succeeds and the policy is actually enforced.
     */
    getVocabPolicy?: (workspace: string) => WorkspaceVocabPolicy;
}

export type GateResult =
    | { handled: true }
    | { handled: false; typeWarning?: string };

/**
 * Reject extra fields in the POST body. On reject, writes a 400 and
 * returns `{handled: true}` so the caller exits early.
 */
export function enforceStrictFields(
    body: Record<string, unknown>,
    res: ServerResponse,
): GateResult {
    const unknown = checkUnknownFields(body, STORE_NODE_KNOWN_FIELDS);
    if (unknown.ok) return { handled: false };
    const message = unknown.hint
        ? `unknown_field: ${unknown.rejected.join(', ')} — Did you mean: ${unknown.hint}?`
        : `unknown_field: ${unknown.rejected.join(', ')}`;
    writeError(res, 400, 'unknown_field', message, {
        rejected: unknown.rejected,
        hint: unknown.hint,
        known: STORE_NODE_KNOWN_FIELDS,
    });
    return { handled: true };
}

/**
 * Apply the workspace's vocab policy to `body.type`. Resolved-workspace
 * is taken from `body.workspace` or `deps.activeWorkspace`. Reject and
 * hitl write their own response; warn returns through `typeWarning` so
 * the caller can attach the header to the eventual 200.
 */
export async function enforceVocabPolicy(
    body: { type: string; workspace?: string },
    res: ServerResponse,
    deps: GateDeps,
): Promise<GateResult> {
    const resolvedWorkspaceName =
        typeof body.workspace === 'string' && body.workspace.length > 0
            ? body.workspace
            : deps.activeWorkspace;
    try {
        const policy = deps.getVocabPolicy
            ? deps.getVocabPolicy(resolvedWorkspaceName)
            : getWorkspaceVocabPolicy(resolvedWorkspaceName);
        const verdict = checkVocab({
            policy,
            type: body.type,
            coreTypes: deps.coreNodeTypes ?? [],
        });
        if (verdict.decision === 'reject') {
            writeError(res, 400, 'type_not_allowed', verdict.reason ?? 'type not allowed', {
                reason: verdict.reason,
                ...(verdict.hint ? { hint: verdict.hint } : {}),
            });
            return { handled: true };
        }
        if (verdict.decision === 'hitl') {
            if (!deps.pendingOpsStore) {
                const reason = `${verdict.reason} (pendingOpsStore not wired in this deployment)`;
                writeError(res, 503, 'hitl_unavailable', reason, { reason });
                return { handled: true };
            }
            const principal = getCurrentPrincipal();
            const pending = await deps.pendingOpsStore.enqueue({
                operation: 'store_node',
                workspaceId: resolvedWorkspaceName,
                // F-B1 — record the AUTHENTICATED requester, not the constant
                // 'http'. The store's self-approval guard compares initiator vs
                // decidedBy; with both bound to real principal identities, the
                // same principal can't enqueue then approve its own op, while a
                // different approver (operator) still can. Null principal
                // (local/legacy) falls back to 'http' (unchanged for tests).
                //
                // FIX 6 (launch-fixes-2026-08) — stamp the SAME `kind ===
                // 'bootstrap' ? 'human' : 'system'` prefix that
                // mcp/http/routes/approvals.ts's decide endpoint now stamps
                // `decidedBy` with (see that file's own comment). Before this
                // fix, this initiator was the BARE label ("bootstrap") while
                // approvals.ts was about to start stamping `decidedBy` as
                // "human:bootstrap" for the identical principal — a mismatch
                // that would have made initiator !== decidedBy ALWAYS true for
                // the same physical operator, silently DISABLING self-approval
                // blocking for this HITL queue (the opposite failure mode from
                // the schema_approve bug, but the same root cause: two call
                // sites stamping one identity concept two different ways).
                initiator: principal ? `${principal.kind === 'bootstrap' ? 'human' : 'system'}:${principal.label}` : 'http',
                args: body,
                enqueueRationale: verdict.reason,
            });
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'pending_human_review',
                pending_op_id: pending.id,
                reason: verdict.reason,
                workspace: resolvedWorkspaceName,
                type: body.type,
            }));
            return { handled: true };
        }
        if (verdict.decision === 'warn') {
            return { handled: false, typeWarning: verdict.reason };
        }
    } catch (policyErr) {
        // Soft policy lookup failure (e.g. workspaces.json edited mid-
        // request). Log and continue with default-accept behavior.
        console.error(
            `[Lore HTTP] vocab policy lookup failed for "${resolvedWorkspaceName}": ${(policyErr as Error).message}`,
        );
    }
    return { handled: false };
}
