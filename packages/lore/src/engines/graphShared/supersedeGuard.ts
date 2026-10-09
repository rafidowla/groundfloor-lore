/**
 * supersedeGuard.ts — the "claim" rule every engine's `supersedeNode` shares
 * (conditional writes, phase 1 / R2).
 *
 * A node may be superseded by exactly one successor. For an old node whose
 * `supersededBy` is:
 *   - empty                -> free: proceed and claim it;
 *   - the same new id      -> an idempotent retry: succeed, change nothing;
 *   - a different id       -> lost the race / stale caller: refuse with
 *                             `already-superseded` and name the winner.
 *
 * Engines apply the rule twice: once against the node they just read (cheap,
 * in-process), and — on arcade and sqlite — again inside the UPDATE itself
 * (`WHERE … supersededBy IS NULL OR '' OR = :new`), so two daemons sharing one
 * database cannot both claim the same node.
 */

/** `reason` an engine returns when the old node already has another successor. */
export const ALREADY_SUPERSEDED_REASON = 'already-superseded';

export interface SupersedeResult {
    ok: boolean;
    reason?: string;
    /** ok:true only — the node was already superseded by this very id; nothing was written. */
    unchanged?: boolean;
    /** reason === ALREADY_SUPERSEDED_REASON only — the id that holds the claim. */
    supersededBy?: string;
}

/** Decide from a node's current `supersededBy`. null = free, go ahead and claim. */
export function supersedeGuardVerdict(
    current: string | null | undefined,
    newId: string,
): SupersedeResult | null {
    if (!current) return null;
    if (current === newId) return { ok: true, unchanged: true };
    return { ok: false, reason: ALREADY_SUPERSEDED_REASON, supersededBy: current };
}

/** The wire message for an already-superseded refusal (bulk item error, 409 body, MCP message). */
export function alreadySupersededMessage(oldId: string, supersededBy: string): string {
    return `${oldId} is already superseded by ${supersededBy}`;
}
