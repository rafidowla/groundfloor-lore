/**
 * retrieveRelated.ts — assembly of retrieve()'s direct/related split once D1
 * (calibrated relevance), D4 (traversal neighbours in a separate `related`
 * field) and D5 (supersession replacement + `corrects` adjacency) all apply.
 *
 * Extracted from retrieve.ts at the integ/d-all D1+D5 merge to keep that file
 * under the 800-line cap. No new behaviour beyond the integration rules:
 *
 *   - D5 supersession replacement / refillSeedSlots run on the DIRECT map
 *     only, BEFORE traversal, so every `related[].via` names a node that is
 *     actually in `results`.
 *   - D1 `similarity`/`relevance` are (re)derived from each direct result's
 *     OWN vector-leg score after D5 replacement, so a successor that took a
 *     superseded node's slot never inherits the dead node's similarity.
 *   - A superseded traversal hop is replaced by its live, admissible
 *     successor inside `related` (D5 intent), never left visible.
 *   - `corrects` targets that did NOT themselves match the query (D5
 *     `injected: 'corrects'`) are traversal-shaped context, so they live in
 *     `related` (relation 'corrects', via = the correcting node), never in
 *     the ranked/counted `results` (D4 contract). Reordering + `correctedBy`
 *     flags on targets that DID match stay in `results`.
 *
 * License: original work for groundfloor-lore.
 */

import type { LoreNode } from '../providers/types.js';
import type { RetrievalResult, RelatedResult } from './retrieveTypes.js';
import type { CalibrationResult } from './calibration.js';
import { zScore } from './abstention.js';
import { resolveLiveNodes, type AdmitNode } from './supersessionRecall.js';

const TRAVERSE_CONCURRENCY = 4;

type HiddenFlags = LoreNode & { status?: string; supersededBy?: string | null };

interface RelatedGraph {
    traverse(id: string, depth: number): Promise<Array<{ node: LoreNode; depth: number; relation: string }>>;
    getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>>;
}

/** D1 — attach each direct result's OWN similarity / calibrated relevance
 *  (additive only; `score` untouched). Absent when the vector leg never saw
 *  that node or calibration isn't usable. */
export function withOwnRelevance(
    collected: Map<string, RetrievalResult>,
    semanticScoreById: Map<string, number>,
    calibration: CalibrationResult,
): Map<string, RetrievalResult> {
    const out = new Map<string, RetrievalResult>();
    for (const [id, r] of collected) {
        const { similarity: _s, relevance: _r, ...base } = r;
        const sim = semanticScoreById.get(r.node.id) ?? null;
        const rel = zScore(sim, calibration);
        out.set(id, {
            ...base,
            ...(sim !== null ? { similarity: parseFloat(sim.toFixed(3)) } : {}),
            ...(rel !== null ? { relevance: parseFloat(rel.toFixed(2)) } : {}),
        });
    }
    return out;
}

export interface CollectRelatedOptions {
    depth: number;
    /** Actor-scope filter (D2-recall-2) — applied to each hop batch. */
    filterByActorScope: (nodes: LoreNode[]) => LoreNode[];
    /** Ecosystem / archived hop predicate (pre-D5 checks, unchanged). */
    hopAllowed: (n: LoreNode) => boolean;
    /** When true, a superseded hop is replaced by its live successor. */
    replaceSuperseded: boolean;
    /** D5 visibility gate for successors fetched outside the hop list. */
    admit: AdmitNode;
}

/**
 * D4 — graph traversal from the DIRECT results into a SEPARATE collection.
 * A node already in `direct` is never added (a direct match wins), and no
 * id appears twice.
 */
export async function collectRelated(
    direct: Map<string, RetrievalResult>,
    graph: RelatedGraph,
    opts: CollectRelatedOptions,
): Promise<Map<string, RelatedResult>> {
    const related = new Map<string, RelatedResult>();
    if (opts.depth <= 0) return related;
    const seeds = [...direct.values()].map((r) => r.node);
    for (let i = 0; i < seeds.length; i += TRAVERSE_CONCURRENCY) {
        const batch = seeds.slice(i, i + TRAVERSE_CONCURRENCY);
        const hops = await Promise.all(batch.map((sn) => graph.traverse(sn.id, opts.depth)));
        for (let idx = 0; idx < batch.length; idx++) {
            const sn = batch[idx]!;
            // D2-recall-2: traverse() does no scope filtering — filter every
            // hop through the actor's scopes before it can surface.
            const allowedHops = new Set(opts.filterByActorScope(hops[idx]!.map((item) => item.node)).map((n) => n.id));
            for (const item of hops[idx]!) {
                if (!allowedHops.has(item.node.id) || !opts.hopAllowed(item.node)) continue;
                let node: LoreNode | undefined = item.node;
                if (opts.replaceSuperseded && (node as HiddenFlags).supersededBy) {
                    node = (await resolveLiveNodes([node], graph, opts.admit))[0];
                    if (!node) continue; // no admissible live successor — drop, never show the dead node
                }
                if (direct.has(node.id) || related.has(node.id)) continue;
                // `relation` is the REAL edge relation traverse() reported.
                related.set(node.id, { node, via: sn.id, relation: item.relation, depth: item.depth, score: 0.3 / (1 + item.depth) });
            }
        }
    }
    return related;
}

/**
 * D5 x D4 — move `corrects` targets that applyCorrectsAdjacency INJECTED
 * (they did not match the query) out of the ranked array into `related`.
 * They go to the front of `related`, in the order the adjacency pass
 * placed them, replacing any plain traversal entry for the same id.
 */
export function splitCorrectsInjections(
    results: RetrievalResult[],
    related: RelatedResult[],
): { results: RetrievalResult[]; related: RelatedResult[] } {
    const kept: RetrievalResult[] = [];
    const moved: RelatedResult[] = [];
    for (const r of results) {
        const injected = (r.node as LoreNode & { injected?: string }).injected === 'corrects' && r.source.startsWith('corrects:');
        if (!injected) { kept.push(r); continue; }
        moved.push({ node: r.node, via: r.source.slice('corrects:'.length), relation: 'corrects', depth: 1, score: 0.3 / 2 });
    }
    if (moved.length === 0) return { results, related };
    const movedIds = new Set(moved.map((m) => m.node.id));
    return { results: kept, related: [...moved, ...related.filter((r) => !movedIds.has(r.node.id))] };
}
