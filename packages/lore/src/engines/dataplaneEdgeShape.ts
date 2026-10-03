/**
 * dataplaneEdgeShape.ts — cloud `lore_edge` row <-> LoreEdge mapping and the endpoint check
 * (cloud parity Slice B item 10). Mirrors local `sqliteGraphWrites.addEdge`: both endpoints must
 * exist in the caller's Lore workspace, confidence defaults to extracted / 1.0, and rows written
 * before the confidence columns existed read back with those same defaults.
 */
import type { LoreEdge } from '../providers/types.js';
import { LoreGraphError } from './loreGraphError.js';

/** Stored edge columns (snake_case, D5) for a write: confidence defaults match local. */
export function edgeConfidenceFields(edge: LoreEdge): { confidence: string; confidence_score: number } {
    return { confidence: edge.confidence ?? 'extracted', confidence_score: edge.confidenceScore ?? 1.0 };
}

/** Map a scope-checked `lore_edge` row to a LoreEdge (legacy rows without confidence -> defaults). */
export function rowToLoreEdge(r: Record<string, unknown>): LoreEdge {
    const score = r['confidence_score'];
    return {
        sourceId: r['source_id'] as string,
        targetId: r['target_id'] as string,
        relation: r['relation'] as string,
        confidence: (typeof r['confidence'] === 'string' && r['confidence'] ? r['confidence'] : 'extracted') as LoreEdge['confidence'],
        confidenceScore: typeof score === 'number' && Number.isFinite(score) ? score : 1.0,
    };
}

/** Throw `edge_endpoint_missing` (same wording as local) unless both endpoint ids are present. */
export function assertEdgeEndpoints(edge: LoreEdge, presentIds: ReadonlySet<string>): void {
    const missing = [
        presentIds.has(edge.sourceId) ? null : `source '${edge.sourceId}'`,
        presentIds.has(edge.targetId) ? null : `target '${edge.targetId}'`,
    ].filter(Boolean).join(' and ');
    if (!missing) return;
    throw new LoreGraphError(
        `edge_endpoint_missing: ${missing} not found — the node must be written (and committed) before its edges`,
        'addEdge',
    );
}
