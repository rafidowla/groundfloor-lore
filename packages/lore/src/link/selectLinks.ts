/**
 * selectLinks.ts - pure link selection for one arriving node.
 *
 * Calibrated threshold, then top-k. No diversity (RNG) pruning: in a memory
 * graph a tight cluster of near-duplicates is the supersession / refinement
 * signal, not noise (design section 4, Loop A). Neighbours at or above
 * `dupSim` are linked like any other AND reported as duplicate candidates.
 */
import type { LinkPolicy } from './linkConfig.js';
import { SEMANTIC_RELATION, type DuplicateCandidate, type InferredEdge } from './linkTypes.js';

export interface NeighbourHit {
    /** Verbatim row id, `lore:<nodeId>` for graph nodes. */
    id: string;
    score: number;
}

export interface LinkSelection {
    edges: InferredEdge[];
    duplicates: DuplicateCandidate[];
}

const ROW_ID_PREFIX = 'lore:';
/** Question-alias rows (`lore:<id>#q0`) carry the parent's vector for recall; they are not nodes. */
const QUESTION_ALIAS = /#q\d+$/;

/** `lore:abc` -> `abc`; anything else (history rows, alias rows, other pillars) -> null. */
export function nodeIdOfRow(rowId: string): string | null {
    if (!rowId.startsWith(ROW_ID_PREFIX) || rowId.includes('#rev') || QUESTION_ALIAS.test(rowId)) return null;
    const id = rowId.slice(ROW_ID_PREFIX.length);
    return id.length > 0 ? id : null;
}

export function sortedPair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
}

export function selectLinks(nodeId: string, hits: readonly NeighbourHit[], policy: LinkPolicy): LinkSelection {
    const ranked = [...hits].sort((x, y) => (y.score - x.score) || x.id.localeCompare(y.id));
    const edges: InferredEdge[] = [];
    const duplicates: DuplicateCandidate[] = [];
    const seen = new Set<string>();
    for (const hit of ranked) {
        if (edges.length >= policy.k) break;
        const other = nodeIdOfRow(hit.id);
        if (other === null || other === nodeId || seen.has(other)) continue;
        if (!(hit.score >= policy.minSim)) continue; // also rejects NaN
        seen.add(other);
        const [lo, hi] = sortedPair(nodeId, other);
        edges.push({ sourceId: lo, targetId: hi, relation: SEMANTIC_RELATION, confidenceScore: hit.score });
        if (hit.score >= policy.dupSim) duplicates.push({ a: lo, b: hi, score: hit.score });
    }
    return { edges, duplicates };
}
