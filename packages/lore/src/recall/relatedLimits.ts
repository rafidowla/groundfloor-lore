/**
 * relatedLimits.ts — C1: two optional trims on recall's `related[]` list.
 *
 *   perHit     LORE_RECALL_RELATED_PER_HIT   keep at most N neighbours per primary hit (after link ordering,
 *                                            so the N strongest). Unset / invalid = no cap (default).
 *   maxDegree  LORE_RECALL_RELATED_MAX_DEGREE  drop a neighbour whose live edge degree (edges in + out,
 *                                            any relation) is above N. Unset / invalid = off (default).
 *
 * Both only ever shape `related[]`. Primary hits are never capped or dropped, a hub that matches the
 * query stays a primary hit. Embedded hosts pass `createLore({ recallRelated: { perHit, maxDegree } })`,
 * which wins over the env; `null` forces a limit off over the env.
 *
 * Degree is counted with two bounded `queryEdges` reads (source side, then target side, each `LIMIT max+1`),
 * so the cost per candidate is O(maxDegree) on the (source) and (target) edge indexes of both SQLite and
 * Postgres. No full scan, no new engine method, and only ever asked about candidates that could still be
 * shown (candidates after the per-hit cap fills are never checked).
 */
import type { StrengthEdge } from './linkOrdering.js';

export interface RecallRelatedOption { perHit?: number | null; maxDegree?: number | null }
export interface RelatedLimits { perHit?: number; maxDegree?: number }

const posInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

function fromEnv(raw: string | undefined): number | undefined {
    const t = raw?.trim();
    if (!t || !/^\d+$/.test(t)) return undefined;
    return posInt(Number(t));
}

/** Validates the embedded option once at construction. Throws RangeError on anything but a positive integer, null or undefined. */
export function parseRecallRelatedOption(o: RecallRelatedOption | undefined): RecallRelatedOption | undefined {
    if (o === undefined) return undefined;
    if (o === null || typeof o !== 'object') throw new RangeError('recallRelated must be an object { perHit?, maxDegree? }');
    for (const k of ['perHit', 'maxDegree'] as const) {
        const v = o[k];
        if (v !== undefined && v !== null && posInt(v) === undefined) throw new RangeError(`recallRelated.${k} must be a positive integer or null`);
    }
    return { ...o };
}

/** option (including an explicit null = off) > env > off. */
export function resolveRelatedLimits(o?: RecallRelatedOption, env: NodeJS.ProcessEnv = process.env): RelatedLimits {
    const pick = (opt: number | null | undefined, name: string): number | undefined =>
        opt === null ? undefined : opt !== undefined ? posInt(opt) : fromEnv(env[name]);
    const perHit = pick(o?.perHit, 'LORE_RECALL_RELATED_PER_HIT');
    const maxDegree = pick(o?.maxDegree, 'LORE_RECALL_RELATED_MAX_DEGREE');
    return { ...(perHit !== undefined ? { perHit } : {}), ...(maxDegree !== undefined ? { maxDegree } : {}) };
}

export interface DegreeGraph {
    queryEdges?(q: { source?: string; target?: string; limit: number; offset: number }): Promise<StrengthEdge[]>;
}

/** True when `id` has more than `maxDegree` live edges. A graph without queryEdges never reports a hub. */
export async function exceedsDegree(graph: DegreeGraph, id: string, maxDegree: number): Promise<boolean> {
    if (typeof graph.queryEdges !== 'function') return false;
    const out = await graph.queryEdges({ source: id, limit: maxDegree + 1, offset: 0 });
    if (out.length > maxDegree) return true;
    const inn = await graph.queryEdges({ target: id, limit: maxDegree + 1 - out.length, offset: 0 });
    return out.length + inn.length > maxDegree;
}
