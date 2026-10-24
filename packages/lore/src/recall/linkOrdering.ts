/**
 * linkOrdering.ts — D4: order a seed's related expansion by link strength.
 *
 * Behind `LORE_RECALL_LINK_ORDERING` (default OFF). Off, `collectRelated`
 * never reaches this module and recall is byte-identical to before.
 *
 * On, the hops of ONE seed are ordered: depth first (unchanged), then within
 * the one-step ring by the strength of the live edge joining the hop to the
 * seed (confidenceScore, highest first), then label, then stable id.
 *
 * This is a pure REORDER of the set traverse() already produced: it adds no
 * hop and drops none, so the per-memory link cap (k, applied when links are
 * written) and the traversal node cap are untouched. Strength is read through
 * `queryEdges`, whose default read is live-only (a soft-invalidated edge is
 * invisible, and traverse() itself only follows live edges), so a stale
 * score can never rank a hop. An engine without `queryEdges` leaves the
 * traversal order alone.
 */
import type { LoreNode } from '../providers/types.js';

export interface StrengthEdge { sourceId: string; targetId: string; relation: string; confidenceScore?: number }
export interface StrengthGraph {
    queryEdges?(q: { source?: string; target?: string; relation?: string; limit: number; offset: number }): Promise<StrengthEdge[]>;
}
export interface Hop { node: LoreNode; depth: number; relation: string }

const PAGE = 500;
const MAX_PAGES = 20;

export function linkOrderingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env.LORE_RECALL_LINK_ORDERING?.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** neighbourId -> strongest live edge score to `seedId` (either direction). */
export async function liveEdgeStrengths(graph: StrengthGraph, seedId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (typeof graph.queryEdges !== 'function') return out;
    for (const side of ['source', 'target'] as const) {
        for (let page = 0; page < MAX_PAGES; page++) {
            const rows = await graph.queryEdges({ [side]: seedId, limit: PAGE, offset: page * PAGE });
            for (const e of rows) {
                const other = side === 'source' ? e.targetId : e.sourceId;
                const s = typeof e.confidenceScore === 'number' && Number.isFinite(e.confidenceScore) ? e.confidenceScore : 1;
                if (s > (out.get(other) ?? -Infinity)) out.set(other, s);
            }
            if (rows.length < PAGE) break;
        }
    }
    return out;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const labelOf = (n: LoreNode): string => String((n as { label?: unknown }).label ?? '');

/** Returns a new array; the input is not mutated. */
export async function orderHopsByLinkStrength<T extends Hop>(graph: StrengthGraph, seedId: string, hops: T[]): Promise<T[]> {
    if (hops.length < 2 || typeof graph.queryEdges !== 'function') return hops;
    const strength = await liveEdgeStrengths(graph, seedId);
    return [...hops].sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        if (a.depth === 1) {
            const d = (strength.get(b.node.id) ?? -1) - (strength.get(a.node.id) ?? -1);
            if (d !== 0) return d;
        }
        return cmp(labelOf(a.node), labelOf(b.node)) || cmp(a.node.id, b.node.id);
    });
}
