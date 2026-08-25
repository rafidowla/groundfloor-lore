/**
 * promotionPipeline.ts — Mem → Know promotion pipeline (V3.0 Phase A5).
 *
 * Implements the "soft split" promotion path locked in
 * `lore-mem-know-soft-split-2026-05-07`:
 *
 *   1. Background process scans `mem.*` (episodic) data for patterns.
 *   2. Pattern detected → emits a PromotionCandidate (a proposed
 *      assertion about a `know.*` (factual) node, with confidence
 *      and citations back to source memories).
 *   3. Pipeline routes the candidate:
 *        - confidence ≥ workspace threshold → auto-apply via NodeStorage,
 *          record provenance, emit audit, supports edge added.
 *        - confidence < threshold → enqueue to ClassificationExceptionQueue
 *          for curator review (when curator queue is enabled).
 *
 * This file is the SCAFFOLD: the data flow + audit + threshold logic.
 * The "scan mem.* for patterns" producer is a separate module wired in
 * later (V4+ learning loop). For now, callers (admin app, test
 * harnesses) construct PromotionCandidates explicitly.
 */

import { randomUUID } from 'node:crypto';

import type { ProvenanceRef } from '../schemas/types.js';
import {
    ClassificationAuditLogger,
    type ClassificationAuditEntry,
} from '../security/classificationAudit.js';
import {
    ClassificationExceptionQueue,
} from '../security/classificationExceptionQueue.js';

/**
 * One promotion candidate. Flat structure so the curator UI can render
 * it without extra lookups. `supports` lists episodic source ids that
 * back the assertion; the pipeline persists `supports` edges from each
 * source to the new factual node when the candidate auto-applies.
 */
export interface PromotionCandidate {
    /** Workspace this candidate belongs to. */
    workspace: string;
    /** Target factual node type (e.g. 'know.Tenant'). */
    proposedNodeType: string;
    /** Field values for the new factual node (declared fields only — floor filled in by NodeStorage). */
    proposedFields: Record<string, unknown>;
    /** Stable fingerprint of the assertion shape (for de-dupe). */
    inputFingerprint: string;
    /** AI's confidence the assertion is correct, 0..1. */
    confidence: number;
    /** Subject id of the agent that produced the candidate. */
    decidedBy: string;
    /** Episodic node ids that support this assertion. */
    supports: string[];
    /** Free-form reasoning for the curator UI / audit log. */
    reasoning?: string;
}

export interface PromotionWorkspaceConfig {
    /** Auto-apply when confidence >= threshold. Default 0.90 (Rafi locked 2026-05-07). */
    autoApplyThreshold?: number;
    /** When true and below threshold, enqueue to the curator queue. Default true. */
    enqueueOnLowConfidence?: boolean;
}

const DEFAULT_THRESHOLD = 0.90;

/**
 * Storage hooks the pipeline calls when auto-applying. Substrate-
 * agnostic — caller wires to LocalGraph (Kùzu) or DataplaneGraph.
 */
export interface PromotionStorage {
    /**
     * Create the proposed factual node. Returns the assigned id.
     * Floor fields (id, kind, ingestedAt, etc.) are the storage's
     * concern — caller decides via the surrounding crud/dedupe path.
     */
    createFactualNode(input: {
        workspace: string;
        type: string;
        fields: Record<string, unknown>;
        provenance: ProvenanceRef;
        createdBy: string;
    }): Promise<{ id: string }>;
    /**
     * Persist a `supports` edge from each episodic source to the new
     * factual node. The pipeline calls this once per candidate after
     * createFactualNode succeeds.
     */
    addSupportsEdges(input: {
        workspace: string;
        sourceIds: string[];
        targetId: string;
    }): Promise<void>;
}

export type PromotionOutcome =
    | { kind: 'auto-applied'; nodeId: string; confidence: number }
    | { kind: 'queued-exception'; entryId: string; confidence: number }
    | { kind: 'dropped'; reason: string };

export class PromotionPipeline {
    constructor(
        private readonly storage: PromotionStorage,
        private readonly classAudit: ClassificationAuditLogger,
        private readonly exceptionQueue: ClassificationExceptionQueue,
        private readonly config: Required<PromotionWorkspaceConfig> = {
            autoApplyThreshold: DEFAULT_THRESHOLD,
            enqueueOnLowConfidence: true,
        },
    ) { }

    /** Replace the active workspace config (e.g., when a curator changes the threshold). */
    reconfigure(config: PromotionWorkspaceConfig): void {
        if (typeof config.autoApplyThreshold === 'number') {
            (this.config as PromotionWorkspaceConfig).autoApplyThreshold = config.autoApplyThreshold;
        }
        if (typeof config.enqueueOnLowConfidence === 'boolean') {
            (this.config as PromotionWorkspaceConfig).enqueueOnLowConfidence = config.enqueueOnLowConfidence;
        }
    }

    /** Submit a candidate. Routes auto-apply / queue based on confidence + config. */
    async submit(candidate: PromotionCandidate): Promise<PromotionOutcome> {
        validateCandidate(candidate);
        const at = new Date().toISOString();

        if (candidate.confidence >= this.config.autoApplyThreshold) {
            // Auto-apply.
            const provenance: ProvenanceRef = {
                sourceUri: `promotion:${candidate.inputFingerprint}`,
                ingestedAtIso: at,
                transformChain: [
                    'pattern-detection',
                    `promoted-from:${candidate.supports.join(',')}`,
                ],
            };
            const result = await this.storage.createFactualNode({
                workspace: candidate.workspace,
                type: candidate.proposedNodeType,
                fields: candidate.proposedFields,
                provenance,
                createdBy: candidate.decidedBy,
            });
            await this.storage.addSupportsEdges({
                workspace: candidate.workspace,
                sourceIds: candidate.supports,
                targetId: result.id,
            });
            this.appendAudit({
                at,
                workspace: candidate.workspace,
                inputFingerprint: candidate.inputFingerprint,
                decidedBy: candidate.decidedBy,
                confidence: candidate.confidence,
                outcome: 'routed',
                kind: 'factual',
                nodeType: candidate.proposedNodeType,
                reason: candidate.reasoning,
            });
            return { kind: 'auto-applied', nodeId: result.id, confidence: candidate.confidence };
        }

        if (!this.config.enqueueOnLowConfidence) {
            this.appendAudit({
                at,
                workspace: candidate.workspace,
                inputFingerprint: candidate.inputFingerprint,
                decidedBy: candidate.decidedBy,
                confidence: candidate.confidence,
                outcome: 'dropped',
                reason: 'below-threshold; curator queue disabled',
            });
            return { kind: 'dropped', reason: 'below-threshold; curator queue disabled' };
        }

        // Enqueue.
        const entryId = randomUUID();
        this.exceptionQueue.enqueue({
            id: entryId,
            at,
            workspace: candidate.workspace,
            inputFingerprint: candidate.inputFingerprint,
            guess: {
                decidedBy: candidate.decidedBy,
                confidence: candidate.confidence,
                proposedKind: 'factual',
                proposedNodeType: candidate.proposedNodeType,
                reasoning: candidate.reasoning,
            },
            sample: candidate.proposedFields,
        });
        this.appendAudit({
            at,
            workspace: candidate.workspace,
            inputFingerprint: candidate.inputFingerprint,
            decidedBy: candidate.decidedBy,
            confidence: candidate.confidence,
            outcome: 'queued-exception',
            reason: candidate.reasoning,
        });
        return { kind: 'queued-exception', entryId, confidence: candidate.confidence };
    }

    /* ---------- internals ---------- */

    private appendAudit(entry: ClassificationAuditEntry): void {
        try { this.classAudit.append(entry); } catch { /* never break pipeline on audit failure */ }
    }
}

/* ---------- helpers ---------- */

function validateCandidate(c: PromotionCandidate): void {
    if (!c.workspace) throw new Error('promotion candidate missing workspace');
    if (!c.proposedNodeType) throw new Error('promotion candidate missing proposedNodeType');
    if (!c.inputFingerprint) throw new Error('promotion candidate missing inputFingerprint');
    if (!c.decidedBy) throw new Error('promotion candidate missing decidedBy');
    if (typeof c.confidence !== 'number' || c.confidence < 0 || c.confidence > 1) {
        throw new Error('promotion candidate confidence must be a number in [0..1]');
    }
    if (!Array.isArray(c.supports)) throw new Error('promotion candidate supports must be an array');
}
