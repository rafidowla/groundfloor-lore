/**
 * recallOutcome.ts — 3.21 step 3(h). A recall-adjacent front door onto the
 * EXISTING outcome-weighting mechanism (Feature 2, 2026-05-26): AuxStore's
 * node_outcomes table + the denormalized success_count/failure_count/
 * partial_count/confirmation_score fields on the graph node, which
 * recall/ranking.ts's outcomeWeight() already reads on every rankScore()
 * call. NO new ranking math — this module calls the SAME primitives
 * `record_outcome` / POST /api/nodes/:id/outcomes already call
 * (deps.auxStore.recordOutcome, graph.upsertNode with the recomputed
 * counters).
 *
 * Vocabulary + meaning are IDENTICAL to record_outcome — 'success' |
 * 'failure' | 'partial' describe the outcome of ACTING on the recalled
 * memory (did following it work?), not whether the memory was relevant to
 * the query. (Opus review, 3.21 step 3h round 2: an earlier draft of this
 * tool invented its own 'used'/'not_used'/'wrong' vocabulary and mapped
 * 'wrong' → 'failure' — but ranking.ts's outcomeWeight() BOOSTS failure
 * outcomes (DEFAULT_FAILURE_BOOST 0.5, "surface MORE prominently … so the
 * agent sees this approach failed before") specifically so a node that
 * misled ranks HIGHER as a warning. Calling a node "wrong" and having it
 * rank higher for that is the correct behaviour for record_outcome's own
 * meaning, but it is NOT what a caller reporting "this recall result was
 * irrelevant" wants — that is relevance feedback, a different signal
 * ranking.ts does not implement in 3.21. Recall_outcome is scoped
 * strictly to record_outcome's existing meaning to avoid smuggling a
 * mismatched signal through it.)
 *
 * `queryId` is a caller-supplied correlation token (recall's response now
 * carries one — see recallPreset.ts / recallTool.ts's compact branch) with
 * nowhere structured to live: node_outcomes has no queryId column and this
 * module does not add one (that would be new schema, not "feed the
 * existing mechanism"). It is folded into the existing free-text `notes`
 * column instead, exactly like a caller-supplied note would be.
 */

import { randomUUID } from 'node:crypto';
import type { AuxStore, OutcomeStatus } from '../outbox/auxStore.js';
import type { VersionStore } from '../outbox/versionStore.js';
import type { LoreNode } from '../providers/types.js';
import { withTransactionConflictRetry } from '../engines/transactionConflictRetry.js';

/** Re-exported under this module's own name for callers that don't want
 *  to reach into outbox/auxStore.js directly — but this IS record_outcome's
 *  own type, not a parallel vocabulary. */
export type RecallOutcomeValue = OutcomeStatus;

export function isRecallOutcomeValue(v: unknown): v is RecallOutcomeValue {
    return v === 'success' || v === 'failure' || v === 'partial';
}

/** Same formula record_outcome / POST /api/nodes/:id/outcomes already use
 *  (outcomes.ts, mcp/http/routes/outcomes.ts) — duplicated here rather than
 *  imported so this module has no dependency on either tool-layer file;
 *  all three copies compute the identical pure function. */
function calcConfirmationScore(success: number, failure: number, partial: number): number {
    const total = success + failure + partial * 0.5;
    if (total === 0) return 0;
    return Math.round((success / total) * 1000) / 1000;
}

/** Minimal graph surface this needs — satisfied by every LoreGraphHandle. */
export interface RecallOutcomeGraph {
    initialize(): Promise<void>;
    getNode(id: string): Promise<LoreNode | null>;
    upsertNode(node: LoreNode): Promise<LoreNode>;
}

export interface ApplyRecallOutcomeArgs {
    auxStore: AuxStore;
    graph: RecallOutcomeGraph;
    versionStore?: VersionStore;
    nodeId: string;
    workspace: string;
    /** record_outcome's own vocabulary and meaning, exactly — the outcome
     *  of ACTING on the recalled memory. Not a relevance judgment. */
    outcome: RecallOutcomeValue;
    queryId?: string;
    recordedBy?: string;
    /** 'mcp' | 'http' — mirrors the `principal` field record_outcome's two
     *  existing call sites stamp on the version record. */
    principal: string;
}

export type ApplyRecallOutcomeResult =
    | {
        ok: true;
        outcomeId: string;
        status: OutcomeStatus;
        newConfirmationScore: number;
        counts: { success: number; failure: number; partial: number };
    }
    | { ok: false; code: 'node_not_found' };

/**
 * Record a recall outcome and recompute + persist the SAME counters
 * ranking.ts's outcomeWeight() reads — the identical write path
 * record_outcome takes, entered from a recall-adjacent surface with an
 * optional queryId for correlation.
 */
export async function applyRecallOutcome(args: ApplyRecallOutcomeArgs): Promise<ApplyRecallOutcomeResult> {
    const { auxStore, graph, versionStore, nodeId, workspace, outcome, queryId, recordedBy, principal } = args;
    await graph.initialize();
    const node = await graph.getNode(nodeId);
    if (!node) return { ok: false, code: 'node_not_found' };

    const status = outcome;
    const outcomeId = randomUUID();
    auxStore.recordOutcome({
        id: outcomeId,
        nodeId,
        workspace,
        status,
        notes: queryId ? `recall_outcome queryId=${queryId}` : undefined,
        recordedBy,
    });

    const counts = auxStore.getOutcomeCount(nodeId, workspace);
    const newScore = calcConfirmationScore(counts.success, counts.failure, counts.partial);

    await withTransactionConflictRetry(() => graph.upsertNode({
        ...node,
        success_count: counts.success,
        failure_count: counts.failure,
        partial_count: counts.partial,
        confirmation_score: newScore,
    } as LoreNode));

    auxStore.incrementCounter(workspace, `outcomes_${status}`);

    if (versionStore) {
        try {
            versionStore.recordVersion({
                versionId: randomUUID(), nodeId, workspace,
                timestamp: new Date().toISOString(), principal,
                operation: 'outcome',
                previousState: node,
                newState: { ...node, success_count: counts.success, failure_count: counts.failure, partial_count: counts.partial, confirmation_score: newScore },
                changesetId: null,
            });
        } catch { /* non-fatal, matches record_outcome's own posture */ }
    }

    return { ok: true, outcomeId, status, newConfirmationScore: newScore, counts };
}
