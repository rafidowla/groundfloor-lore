/**
 * nodeServiceVersion.ts — step 5 of nodeUpsert (local version record), split out of nodeService.ts.
 * Always called INSIDE the per-(workspace,id) node lock.
 */
import { randomUUID } from 'node:crypto';
import type { LoreNode } from '../providers/types.js';
import { shouldRecordVersion } from '../outbox/versionPolicy.js';
import type { NodeUpsertHooks } from './nodeService.js';

/** Step 5 — non-fatal local version record, called INSIDE the node lock (no lock taken by recordVersion; no deadlock). Gated by shouldRecordVersion (outbox/versionPolicy.ts); missing previousState always records. */
export async function recordLocalVersion(
    hooks: NodeUpsertHooks, id: string, workspace: string, nodeData: Record<string, unknown>, node: LoreNode,
    priorNode?: LoreNode | null,
): Promise<void> {
    if (hooks.changesetVersion) {
        // Always recorded (changeset commit never applied the history policy). A failure is NOT thrown out of the
        // lock: 3.38.3 recorded this row after the whole write (WAL append, autolink, then the caller's quota
        // delta), so the write still completes and applyChangesetUpsert hands the error to the caller, which
        // counts the write as failed AFTER its own accounting, exactly as before.
        try {
            await hooks.changesetVersion.versionStore.recordVersion({
                versionId: randomUUID(), nodeId: id, workspace, timestamp: new Date().toISOString(),
                principal: 'changeset', operation: 'upsert', previousState: priorNode ?? null, newState: nodeData,
                changesetId: hooks.changesetVersion.changesetId,
            });
        } catch (err) { hooks.changesetVersion.failure = err ?? new Error('changeset version record failed'); }
        return;
    }
    // `hooks.previousState` is the CALLER's pre-read, taken OUTSIDE the node lock. A purge that ran
    // between that read and this lock left it holding erased content, and recording it here (after
    // the purge's purgedAt bound) would bring that content back. When the caller pre-read at all,
    // the row uses the in-lock prior read instead (null = node gone ⇒ recorded as a create). A caller
    // that passed no pre-read keeps recording `null`, unchanged; `priorNode === undefined` (graph
    // without getNode) falls back to the pre-read.
    const previousState = hooks.previousState != null && priorNode !== undefined ? priorNode : hooks.previousState;
    if (hooks.versionStore && !hooks.versionStore.runWithVersionIntent && shouldRecordVersion(typeof nodeData.type === 'string' ? nodeData.type : undefined, previousState, node, hooks.versionHistoryPolicy)) {
        try {
            await hooks.versionStore.recordVersion({
                versionId: randomUUID(),
                nodeId: id,
                workspace,
                timestamp: new Date().toISOString(),
                principal: hooks.versionPrincipal ?? 'mcp',
                operation: 'upsert',
                previousState: previousState ?? null,
                newState: node,
                changesetId: null,
            });
        } catch { /* non-fatal */ }
    }
}
