/**
 * approvalReplay.ts — Replay an approved second-party HITL op.
 *
 * The approval flow has three phases:
 *
 *   1. enqueue       — `enforceApproval` writes a pending row, returns
 *                      202 with the new id.
 *   2. decide        — a different operator hits
 *                      `POST /api/approvals/{id}/decision` and the row
 *                      flips to `approved` or `rejected`.
 *   3. **replay**    — when approved, the original op needs to actually
 *                      run. This module is that step.
 *
 * Each gated operation registers a handler keyed by its operation
 * name. The handler receives the original args envelope (parsed back
 * from `argsJson`) plus a small context bag (workspaceId, initiator —
 * carried over from the pending row so the replay runs in the same
 * scope). Handler returns void on success or throws on failure.
 *
 * This module does not wire into HTTP. The decision endpoint (or a
 * background sweep — to be wired separately) calls `replayApprovedOp`
 * and then `pendingOpsStore.markExecuted` on success. Failures are
 * surfaced via the result type so the caller can decide whether to
 * leave the row at `approved` for retry or surface the error to the
 * approver.
 *
 * Pure function shape (no HTTP / no global state besides the registry
 * the caller passes in) so it is easy to unit test.
 */

import type { PendingOp } from './pendingOps.js';

export interface ReplayContext {
    workspaceId: string;
    /** The portal_user id of the original initiator (NOT the approver).
     *  Replay runs with the initiator's intent. */
    initiator: string;
    /** The portal_user id of the second-party decider who approved the
     *  pending op. Populated from PendingOp.decidedBy at replay time
     *  (2026-05-17 fix — was previously dropped). Handlers should
     *  credit THIS identity in audit logs, NOT the original args.approver
     *  field, which was set by the initiator and is therefore conflicted. */
    decidedBy: string;
}

export type ReplayHandler = (
    args: unknown,
    ctx: ReplayContext,
) => Promise<void>;

/**
 * Lookup of operation name → replay handler. Plugins / route
 * registrations populate it at boot. Read-only at replay time.
 */
export interface ReplayHandlerRegistry {
    get(operation: string): ReplayHandler | undefined;
}

/**
 * Trivial in-memory registry. Boot wires handlers via `register`;
 * replay calls go through `get`.
 */
export class InMemoryReplayHandlerRegistry implements ReplayHandlerRegistry {
    private readonly handlers = new Map<string, ReplayHandler>();

    register(operation: string, handler: ReplayHandler): void {
        if (this.handlers.has(operation)) {
            throw new Error(`replay handler for '${operation}' is already registered`);
        }
        this.handlers.set(operation, handler);
    }

    get(operation: string): ReplayHandler | undefined {
        return this.handlers.get(operation);
    }

    /** Test helper — wipe all handlers. Not used in production. */
    clear(): void {
        this.handlers.clear();
    }
}

export type ReplayResult =
    | { kind: 'executed' }
    | { kind: 'no-handler'; operation: string }
    | { kind: 'failed'; error: Error };

/**
 * Replay one approved op.
 *
 * Preconditions checked here so callers can't accidentally replay a
 * pending or already-executed row (the store enforces this too, but
 * defense in depth keeps a misuse from corrupting state):
 *   - op.status MUST be 'approved'. Anything else returns an error
 *     (caller should not have called us).
 *
 * On `executed`: caller advances the row via `pendingOpsStore.markExecuted`.
 * On `no-handler`: this is a programming error (an op was enqueued
 *   that nothing knows how to execute). Caller surfaces a 500-ish to
 *   the approver and leaves the row at `approved` so a fix can retry.
 * On `failed`: handler threw. Caller decides retry semantics.
 */
export async function replayApprovedOp(
    op: PendingOp,
    registry: ReplayHandlerRegistry,
): Promise<ReplayResult> {
    if (op.status !== 'approved') {
        return { kind: 'failed', error: new Error(
            `replayApprovedOp: op ${op.id} is ${op.status}, expected 'approved'`,
        )};
    }
    const handler = registry.get(op.operation);
    if (!handler) {
        return { kind: 'no-handler', operation: op.operation };
    }
    let parsedArgs: unknown;
    try {
        parsedArgs = JSON.parse(op.argsJson);
    } catch (e) {
        return { kind: 'failed', error: new Error(
            `replayApprovedOp: op ${op.id} has unparseable argsJson: ${(e as Error).message}`,
        )};
    }
    if (!op.decidedBy) {
        // Defense-in-depth: a row at status 'approved' MUST have a
        // decidedBy (the store guarantees this), but if something
        // upstream skipped that invariant, refuse to replay rather
        // than credit a missing identity.
        return { kind: 'failed', error: new Error(
            `replayApprovedOp: op ${op.id} is 'approved' but has no decidedBy — refusing to replay`,
        )};
    }
    try {
        await handler(parsedArgs, {
            workspaceId: op.workspaceId,
            initiator: op.initiator,
            decidedBy: op.decidedBy,
        });
        return { kind: 'executed' };
    } catch (e) {
        return { kind: 'failed', error: e as Error };
    }
}
