/**
 * supersessionRecall.ts — D5 recall-time behavior for retrieve.ts, split out
 * to keep that file under the 800-line arch cap.
 *
 * Two independent behaviors:
 *  - supersession REPLACEMENT: a superseded node's slot in the result set is
 *    replaced by its successor (never both, never a dangling superseded node
 *    left visible) — contrast with the pre-D5 behavior of simply hiding it.
 *  - `corrects` ADJACENCY: when a result node `corrects` another node, the
 *    corrected node is pulled into the result set (if not already present)
 *    immediately after its correction and flagged `correctedBy`, rather than
 *    being either hidden or left unlinked from the claim that corrects it.
 */

import type { LoreNode } from '../providers/types.js';
import type { RetrievalResult, MatchKind } from './retrieve.js';

type HiddenFlags = LoreNode & { supersededBy?: string | null };

interface SupersessionGraph {
    getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>>;
}

interface CorrectsGraph extends SupersessionGraph {
    // Optional: some RetrievalGraph implementations (older/minimal test
    // doubles built before D5) don't implement queryEdges. Treated as
    // "no corrects edges available" rather than a hard failure — see the
    // guard at the top of applyCorrectsAdjacency below.
    queryEdges?(q: { source?: string; target?: string; relation?: string; limit: number; offset: number }): Promise<Array<{ sourceId: string; targetId: string; relation: string }>>;
}

/** Visibility gate for nodes this module fetches itself (successors,
 *  corrected targets) — they never passed retrieve()'s seed/hop filters, so
 *  the caller supplies the same actor-scope/ecosystem/archived predicate.
 *  Review fix: without it a restricted-scope successor/target leaked. */
export type AdmitNode = (n: LoreNode) => boolean;
const admitAll: AdmitNode = () => true;
const MAX_SUPERSEDE_HOPS = 8;

/**
 * Replace every superseded node in `collected` with its LIVE successor,
 * following `supersededBy` chains (A→B→C resolves to C; bounded, cycle-safe),
 * IN THE SUPERSEDED NODE'S SLOT (insertion order = rank), keeping that
 * slot's rank metadata. A successor already present at a lower rank moves up
 * into the better slot (no duplicate); drops the slot outright
 * when no admissible live successor resolves (deleted, out of scope,
 * archived, cyclic) rather than leaving a stale node visible.
 */
/**
 * Shared successor-chain resolver: A→B→C resolves to C, bounded at
 * MAX_SUPERSEDE_HOPS, cycle-safe (a node revisited in the same chain walk
 * stops the walk rather than looping), and admits the final live node
 * through the caller's visibility predicate. Factored out so both the
 * RetrievalResult-map path (`replaceSupersededInResults`) and the raw
 * LoreNode[] path (`resolveLiveNodes`, for read surfaces that don't build a
 * RetrievalResult) share one walk instead of two copies drifting apart.
 */
function createSuccessorResolver(
    graph: SupersessionGraph,
    admit: AdmitNode,
    seedCache?: Map<string, LoreNode | undefined>,
): (start: string) => Promise<LoreNode | undefined> {
    const cache = seedCache ?? new Map<string, LoreNode | undefined>();
    return async (start: string): Promise<LoreNode | undefined> => {
        const seen = new Set<string>();
        let id: string | null | undefined = start;
        for (let hop = 0; id && hop < MAX_SUPERSEDE_HOPS && !seen.has(id); hop++) {
            seen.add(id);
            if (!cache.has(id)) cache.set(id, (await graph.getNodesByIds([id])).get(id));
            const n = cache.get(id);
            if (!n) return undefined;
            const next = (n as HiddenFlags).supersededBy;
            if (!next) return admit(n) ? n : undefined;
            id = next;
        }
        return undefined; // chain too long or cyclic
    };
}

export async function replaceSupersededInResults(
    collected: Map<string, RetrievalResult>,
    graph: SupersessionGraph,
    admit: AdmitNode = admitAll,
): Promise<Map<string, RetrievalResult>> {
    const superseded = [...collected.values()].filter((r) => (r.node as HiddenFlags).supersededBy);
    if (superseded.length === 0) return collected;
    const cache = new Map<string, LoreNode | undefined>();
    const firstHop = [...new Set(superseded.map((r) => (r.node as HiddenFlags).supersededBy as string))];
    const firstNodes = await graph.getNodesByIds(firstHop); // batched first hop; deeper hops fetched lazily
    for (const id of firstHop) cache.set(id, firstNodes.get(id));
    const resolve = createSuccessorResolver(graph, admit, cache);
    // Rebuild in rank order rather than delete+set: Map.set on a new key
    // APPENDS, so the old delete+set pushed every successor to the end of
    // insertion order — and callers (retrieve(), search's workspace="*"
    // path) read final rank straight from that order, with no re-sort.
    // A successor already present at a LOWER rank moves up into the
    // superseded node's (better) slot and its own lower entry is skipped;
    // slot rank metadata (score/depth/source) is kept so score stays
    // monotonic with position, matchedBy is the union of both entries.
    // similarity/relevance are stripped, never inherited from the dead node:
    // retrieve() recomputes them for the successor's OWN id right after
    // (withOwnRelevance, D1).
    const successorOf = new Map<string, LoreNode | undefined>();
    for (const r of superseded) successorOf.set(r.node.id, await resolve((r.node as HiddenFlags).supersededBy as string));
    const out = new Map<string, RetrievalResult>();
    for (const [id, r] of collected) {
        if (!successorOf.has(id)) {
            if (!out.has(id)) out.set(id, r); // else: already placed higher as a successor
            continue;
        }
        const successor = successorOf.get(id);
        if (!successor) continue; // no live successor resolves: drop the slot
        const placed = out.get(successor.id);
        if (placed) {
            // Successor already holds a better slot: keep it there, but still
            // union this slot's matchedBy so the label doesn't depend on order.
            placed.matchedBy = [...new Set([...placed.matchedBy, ...r.matchedBy])];
            continue;
        }
        const own = collected.get(successor.id);
        const matchedBy = own ? [...new Set([...r.matchedBy, ...own.matchedBy])] : r.matchedBy;
        const { similarity: _s, relevance: _r, ...slot } = r;
        out.set(successor.id, { ...slot, node: successor, matchedBy });
    }
    return out;
}

/**
 * Node-level counterpart to `replaceSupersededInResults` for read surfaces
 * that hydrate a flat `LoreNode[]` of exact hits instead of building a
 * RetrievalResult map (structured_query, GET/POST /api/query's raw hydration,
 * cross-workspace recall's per-workspace seed/keyword hydration, search's
 * legacy workspace="*" fallback). Same successor-chain walk as above: a
 * superseded node's slot is replaced by its live successor in place (order
 * preserved); when the successor is already present elsewhere in `nodes`
 * it keeps the EARLIER of the two positions (moving up if the superseded
 * slot ranked higher) with no duplicate, and the slot is dropped outright
 * when no admissible live successor resolves.
 *
 * `remap`, when given, receives superseded-id → live-successor-id for every
 * slot that resolved, so a caller holding its own id-keyed rank lists
 * (cross-workspace recall's per-workspace RRF) can rewrite them to match.
 *
 * Deliberately does NOT apply `corrects` adjacency (finding #5's other half)
 * — these surfaces exist specifically to return exactly what matched the
 * query for the caller to reshape/hydrate itself (structured_query's own
 * doc comment; /api/query mirrors it). Injecting extra `corrects` targets
 * would violate that "exactly what matched" contract; supersession
 * REPLACEMENT does not, because the replaced node still corresponds 1:1 to
 * the original hit slot, just resolved to its live copy instead of a dead
 * one.
 */
export async function resolveLiveNodes(
    nodes: LoreNode[],
    graph: SupersessionGraph,
    admit: AdmitNode = admitAll,
    remap?: Map<string, string>,
): Promise<LoreNode[]> {
    if (nodes.length === 0) return nodes;
    const resolve = createSuccessorResolver(graph, admit);
    const out: LoreNode[] = [];
    // Same slot rule as replaceSupersededInResults: a successor that is also
    // a hit at a LOWER position moves up into the superseded node's slot and
    // its own later occurrence is skipped (no duplicate).
    const emitted = new Set<string>();
    for (const n of nodes) {
        const supersededBy = (n as HiddenFlags).supersededBy;
        if (!supersededBy) { if (!emitted.has(n.id)) { out.push(n); emitted.add(n.id); } continue; }
        const successor = await resolve(supersededBy);
        if (!successor) continue; // no admissible live successor — drop, don't leave the dead node visible
        remap?.set(n.id, successor.id);
        if (emitted.has(successor.id)) continue; // already took a better slot
        out.push(successor); emitted.add(successor.id);
    }
    return out;
}

/**
 * D5 #6(a) — refill retrieve()'s depth-0 (seed) slots back up to `limit`
 * after `replaceSupersededInResults` has run. `replaceSupersededInResults`
 * can shrink the seed window below `limit`: a dropped seed (no admissible
 * live successor) removes a slot outright, and a replaced seed whose
 * successor collapses onto another slot already in `collected` (two
 * superseded seeds chaining to the same live node, or a successor that was
 * itself already a seed) also nets a slot below `limit`. Pulling from the
 * next-best candidates the caller's limit-slice discarded — resolved
 * through the SAME successor-resolution + admit gate, so a spillover
 * candidate that is itself superseded is resolved rather than inserted
 * stale — keeps the promised `limit` full whenever there is a lower-ranked
 * candidate available to fill it, instead of silently under-returning.
 */
export async function refillSeedSlots(
    collected: Map<string, RetrievalResult>,
    seedSpillover: LoreNode[],
    limit: number,
    graph: SupersessionGraph,
    admit: AdmitNode,
    seedProvenance: Map<string, { matchedBy: Set<MatchKind>; score: number }>,
): Promise<Map<string, RetrievalResult>> {
    let depth0Count = 0;
    for (const r of collected.values()) if (r.depth === 0) depth0Count++;
    if (depth0Count >= limit || seedSpillover.length === 0) return collected;

    const out = new Map(collected);
    const candidates = seedSpillover.filter((n) => !out.has(n.id));
    const resolved = await resolveLiveNodes(candidates, graph, admit);
    for (const n of resolved) {
        if (depth0Count >= limit) break;
        if (out.has(n.id)) continue; // dedupe: successor already present (as a seed or a traversal hop)
        const prov = seedProvenance.get(n.id) ?? { matchedBy: new Set<MatchKind>(['keyword']), score: 0 };
        out.set(n.id, { node: n, score: prov.score, matchedBy: [...prov.matchedBy], depth: 0, source: 'seed' });
        depth0Count++;
    }
    return out;
}

/**
 * Pull `corrects` targets into the result set adjacent to their correction,
 * correction FIRST even when the corrected node out-ranked it. Runs on the
 * ordered results array (post-sort, pre-truncation) so a pair is never split
 * by the token budget. `correctedBy` is a recall-only annotation (not part of
 * the canonical LoreNode shape) naming the correcting node's id.
 */
export async function applyCorrectsAdjacency(
    results: RetrievalResult[],
    graph: CorrectsGraph,
    admit: AdmitNode = admitAll,
): Promise<RetrievalResult[]> {
    if (results.length === 0 || typeof graph.queryEdges !== 'function') return results;
    const ids = results.map((r) => r.node.id);
    const idSet = new Set(ids);

    // D5 #6 — ONE query for the whole result set instead of one `queryEdges`
    // call PER result. `corrects` is a narrow, curated relation (unlike
    // arbitrary graph edges), so a single unfiltered `relation:'corrects'`
    // page covers the normal case; if that single page comes back FULL
    // (more corrects edges may exist workspace-wide than fit one page), we
    // fall back to the previous per-id Promise.all rather than silently
    // miss edges for a workspace with an unusually large corrects graph —
    // no EdgeQuery engine (sqlite/surreal/arcade/dataplane) accepts an
    // `IN (...)` source list today, so a true server-side batched query
    // would need that added across all four backends; out of scope here.
    const BATCH_EDGE_PAGE = 1000;
    let allCorrects = await graph.queryEdges({ relation: 'corrects', limit: BATCH_EDGE_PAGE, offset: 0 });
    let edgesForIds: Array<{ sourceId: string; targetId: string; relation: string }>;
    if (allCorrects.length >= BATCH_EDGE_PAGE) {
        // Page may be truncated — fall back to per-id queries (correctness
        // over the batching optimisation).
        const edgeLists = await Promise.all(
            ids.map((id) => graph.queryEdges!({ source: id, relation: 'corrects', limit: 50, offset: 0 })),
        );
        edgesForIds = edgeLists.flat();
    } else {
        edgesForIds = allCorrects.filter((e) => idSet.has(e.sourceId));
    }
    const bySource = new Map<string, string[]>();
    for (const e of edgesForIds) {
        if (!idSet.has(e.sourceId)) continue;
        const list = bySource.get(e.sourceId);
        if (list) list.push(e.targetId); else bySource.set(e.sourceId, [e.targetId]);
    }
    // Build correctsMap / correctedByPresent walking `ids` in RESULT-RANK
    // order (not edge-arrival order, which the batched query does not
    // guarantee) so "first (highest-ranked) present correction wins" stays
    // deterministic regardless of which query path (batched vs per-id
    // fallback) produced edgesForIds.
    const correctsMap = new Map<string, string[]>();
    const correctedByPresent = new Map<string, string>(); // target -> first (highest-ranked) present correction
    for (const id of ids) {
        const targets = bySource.get(id);
        if (!targets || targets.length === 0) continue;
        correctsMap.set(id, targets);
        for (const targetId of targets) if (!correctedByPresent.has(targetId)) correctedByPresent.set(targetId, id);
    }
    if (correctsMap.size === 0) return results;

    const present = new Set(ids);
    const byId = new Map(results.map((r) => [r.node.id, r]));
    const missing = [...new Set([...correctsMap.values()].flat().filter((id) => !present.has(id)))];
    const fetched = missing.length > 0 ? await graph.getNodesByIds(missing) : new Map<string, LoreNode>();

    const out: RetrievalResult[] = [];
    const placed = new Set<string>();
    const deferred = new Set<string>();
    for (const r of results) {
        if (placed.has(r.node.id)) continue;
        // A present corrected node waits for its correction (unless that
        // correction is itself deferred — mutual corrects must not vanish).
        const corr = correctedByPresent.get(r.node.id);
        if (corr && corr !== r.node.id && !placed.has(corr) && !deferred.has(corr)) { deferred.add(r.node.id); continue; }
        out.push(r);
        placed.add(r.node.id);
        for (const targetId of correctsMap.get(r.node.id) ?? []) {
            if (placed.has(targetId)) continue;
            const own = byId.get(targetId); // target already matched the query itself — keeps ITS OWN rank
            const target = own?.node ?? fetched.get(targetId);
            if (!target || (!own && !admit(target))) continue;
            // D5 #6 — a corrects target that ALREADY matched keeps its own
            // score/depth/matchedBy (just gains `correctedBy`); the
            // correction ranking first is achieved by placement order
            // alone (pushed adjacent, right after its correction), not by
            // inheriting the correction's score. A target injected purely
            // to be adjacent (it did NOT itself match the query) carries no
            // real rank of its own — flagged `injected: 'corrects'` rather
            // than borrowing the correcting node's score/depth.
            out.push(own ? {
                ...own,
                node: { ...own.node, correctedBy: r.node.id } as LoreNode,
            } : {
                node: { ...target, correctedBy: r.node.id, injected: 'corrects' } as LoreNode,
                score: 0,
                matchedBy: ['traversal'],
                depth: r.depth,
                source: `corrects:${r.node.id}`,
            });
            placed.add(targetId);
        }
    }
    for (const r of results) if (!placed.has(r.node.id)) out.push(r); // safety net: never drop a result
    return out;
}
