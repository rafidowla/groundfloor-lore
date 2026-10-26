/**
 * linkDiff.ts - the link DIFF shared by the rebuild (Loop C) and refresh-on-change (Loop B).
 *
 * Given the link sets a batch of nodes WOULD get today (`ComputedLinks`) it reconciles them with the live
 * `link_on_arrival` edges touching those nodes:
 *
 *   wanted, absent            -> inserted
 *   wanted, present, stale    -> refreshed in place (policy / model stamp or score changed)
 *   wanted, present, same     -> unchanged (NOT written)
 *   present, wanted by nobody -> soft-invalidated (`valid_to`), never deleted
 *
 * Safety rules (each has a test in link-rebuild-unit.ts or link-refresh-unit.ts):
 *   - A node that opted out of linking (`autolink:false`, durable) is skipped as a link source AND as a link
 *     target: its existing links are left exactly as they are (counted in `skippedOptOut`).
 *   - Only edges whose origin is exactly `link_on_arrival` are ever invalidated. Caller, import, reconnect,
 *     discovery and legacy NULL-origin edges are untouched; a wanted pair they already hold is left alone.
 *   - An edge is dropped only when NEITHER endpoint wants it, judged from a FRESH recompute of the endpoint
 *     outside the batch (kNN is asymmetric: A may not list B while B lists A). An endpoint with no stored
 *     vector is "unknown", never "empty".
 *
 * The caller decides which edges the batch is allowed to judge (`owns`): the rebuild walks the whole workspace
 * and lets only the batch holding an edge's owner judge it; refresh-on-change judges every edge touching a node
 * that just changed.
 */
import { withEdgeLocks } from '../core/nodeWriteLock.js';
import type { LoreEdge } from '../providers/types.js';
import { boundedMap, LINK_READ_CONCURRENCY } from './boundedMap.js';
import { sortedPair } from './selectLinks.js';
import { SEMANTIC_RELATION, type BatchEdgeResult, type InferredEdge } from './linkTypes.js';
import type { ComputedLinks, LinkGraph } from './storedVectorLinker.js';

/** The substrate calls the diff makes (StoredVectorLinker implements them). */
export interface DiffSubstrate {
    computeLinks(workspace: string, ids: string[]): Promise<ComputedLinks | null>;
    currentStamp(): { policyVersion: string; modelFingerprint: string | null };
    writeInferred(workspace: string, graph: LinkGraph, edges: InferredEdge[]): Promise<BatchEdgeResult>;
}

/** Counters the diff adds to (a `RebuildState` satisfies this directly). */
export interface DiffCounters {
    inserted: number;
    refreshed: number;
    invalidated: number;
    unchanged: number;
    keptForeign: number;
    skippedNoVector: number;
    skippedOptOut?: number;
}

export const emptyDiffCounters = (): DiffCounters => ({ inserted: 0, refreshed: 0, invalidated: 0, unchanged: 0, keptForeign: 0, skippedNoVector: 0, skippedOptOut: 0 });

const EDGE_PAGE = 1000;
const SCORE_EPS = 1e-5;
export const pairKey = (a: string, b: string): string => { const [lo, hi] = sortedPair(a, b); return `${lo}\u0000${hi}`; };

/** Every LIVE `semantic_neighbor` edge touching any of `ids`, deduplicated by pair, with provenance. */
export async function edgesTouching(graph: LinkGraph, ids: readonly string[]): Promise<Map<string, LoreEdge>> {
    const out = new Map<string, LoreEdge>();
    // One round trip per (node, side) on a networked store: read a few at a time, then merge in the ORIGINAL order so
    // the first edge seen for a pair still wins exactly as it did when this loop was sequential.
    const slots = ids.flatMap((id) => (['source', 'target'] as const).map((side) => ({ id, side })));
    const pages = await boundedMap(slots, LINK_READ_CONCURRENCY, async ({ id, side }) => {
        const edges: LoreEdge[] = [];
        for (let offset = 0; ; offset += EDGE_PAGE) {
            const page = await graph.queryEdges!({ [side]: id, relation: SEMANTIC_RELATION, limit: EDGE_PAGE, offset, includeProvenance: true });
            edges.push(...page);
            if (page.length < EDGE_PAGE) break;
        }
        return edges;
    });
    for (const edges of pages) for (const e of edges) { const k = pairKey(e.sourceId, e.targetId); if (!out.has(k)) out.set(k, e); }
    return out;
}

/** One node's computed link set, as kept by a `ComputedWindow` so a later reconcile can reuse it. */
export interface NodeLinks { edges: InferredEdge[]; noVector: boolean; optedOut: boolean }

/**
 * The link sets computed in THIS rebuild run for the last few batches (current, previous, prefetched next). Lets
 * `reconcileLinks` skip the second kNN for an outside endpoint whose set was already computed from the same stored
 * vector and policy. Nothing is persisted and nothing older than `keep` batches is held.
 */
export class ComputedWindow {
    private gens: Map<string, NodeLinks>[] = [];
    constructor(private readonly keep: number) {}
    add(c: ComputedLinks, ids: readonly string[]): void {
        const g = new Map<string, NodeLinks>();
        const nv = new Set(c.noVector);
        const oo = new Set(c.optedOut);
        for (const id of ids) g.set(id, { edges: c.bySource.get(id) ?? [], noVector: nv.has(id), optedOut: oo.has(id) });
        this.gens.push(g);
        while (this.gens.length > this.keep) this.gens.shift();
    }
    get(id: string): NodeLinks | undefined {
        for (let i = this.gens.length - 1; i >= 0; i--) { const v = this.gens[i]!.get(id); if (v) return v; }
        return undefined;
    }
}

export interface ReconcileArgs {
    workspace: string;
    graph: LinkGraph;
    sub: DiffSubstrate;
    /** The nodes whose link sets `computed` describes. */
    batch: readonly string[];
    computed: ComputedLinks;
    /** Which existing edges this batch may judge (insert-only decisions need no ownership). */
    owns: (e: LoreEdge) => boolean;
    now: () => number;
    counters: DiffCounters;
    /** Link sets already computed in this run; an outside endpoint found here is not recomputed. Omit for the old behaviour. */
    reuse?: { get(id: string): NodeLinks | undefined };
}

export interface ReconcileResult {
    /** Edges inserted or re-asserted. */
    written: number;
    /** Edges soft-invalidated. */
    invalidated: number;
    /** Of the writes: pairs already held by a non-inferred edge (left alone) and pairs whose endpoint vanished. */
    keptExisting: number;
    skippedMissingEndpoint: number;
    /** Outside endpoints whose link set was reused instead of recomputed. */
    reused: number;
}

export async function reconcileLinks(a: ReconcileArgs): Promise<ReconcileResult> {
    const { workspace, graph, sub, computed, counters: st } = a;
    const stamp = sub.currentStamp();
    const batchSet = new Set(a.batch);

    const wanted = new Map<string, InferredEdge>();
    for (const edges of computed.bySource.values()) for (const e of edges) wanted.set(pairKey(e.sourceId, e.targetId), e);
    // No vector => link set UNKNOWN; a vanished node (`gone`) is node-delete repair territory, so its edges are left alone here too.
    const unknown = new Set([...computed.noVector, ...computed.gone]);
    const optedOut = new Set(computed.optedOut);
    const existing = await edgesTouching(graph, a.batch);

    const isOurs = (e: LoreEdge): boolean => e.provenance?.origin === 'link_on_arrival';
    const same = (e: LoreEdge, w: InferredEdge): boolean =>
        e.provenance?.policyVersion === stamp.policyVersion && (e.provenance?.modelFingerprint ?? null) === stamp.modelFingerprint
        && Math.abs((e.confidenceScore ?? 0) - w.confidenceScore) <= SCORE_EPS;

    // Edges not wanted by anyone in this batch: their other endpoint (outside the batch) gets a FRESH recompute.
    const notWanted: LoreEdge[] = [];
    for (const [k, e] of existing) if (!wanted.has(k) && isOurs(e) && a.owns(e)) notWanted.push(e);
    const outside = new Set<string>();
    for (const e of notWanted) for (const n of [e.sourceId, e.targetId]) if (!batchSet.has(n)) outside.add(n);
    const reusedSets = new Map<string, NodeLinks>();
    const toCompute: string[] = [];
    for (const n of outside) { const r = a.reuse?.get(n); if (r) reusedSets.set(n, r); else toCompute.push(n); }
    const fresh = toCompute.length > 0 ? await sub.computeLinks(workspace, toCompute) : null;
    if (toCompute.length > 0 && !fresh) throw new Error('workspace_unavailable');
    for (const n of fresh?.noVector ?? []) unknown.add(n);
    for (const n of fresh?.optedOut ?? []) optedOut.add(n);
    for (const [n, r] of reusedSets) { if (r.noVector) unknown.add(n); if (r.optedOut) optedOut.add(n); }
    const wantedByOutside = new Map<string, InferredEdge>();
    if (reusedSets.size === 0) {
        for (const edges of fresh?.bySource.values() ?? []) for (const e of edges) wantedByOutside.set(pairKey(e.sourceId, e.targetId), e);
    } else {
        // Keep the later-wins order of the single recompute: walk the outside endpoints in their original order.
        for (const n of outside) for (const e of (reusedSets.get(n)?.edges ?? fresh?.bySource.get(n) ?? [])) wantedByOutside.set(pairKey(e.sourceId, e.targetId), e);
    }

    const inserts: InferredEdge[] = [];
    const refreshes: InferredEdge[] = [];
    const drops: LoreEdge[] = [];

    for (const [k, w] of wanted) {
        const e = existing.get(k);
        if (!e) { inserts.push(w); continue; }
        if (!a.owns(e)) continue;
        if (!isOurs(e)) { st.keptForeign++; continue; }
        if (same(e, w)) st.unchanged++; else refreshes.push(w);
    }
    for (const e of notWanted) {
        // An opted-out endpoint (autolink:false) is skipped as source AND target: its existing links are left exactly as they are.
        if (optedOut.has(e.sourceId) || optedOut.has(e.targetId)) { st.skippedOptOut = (st.skippedOptOut ?? 0) + 1; continue; }
        const k = pairKey(e.sourceId, e.targetId);
        const byOutside = wantedByOutside.get(k);
        if (byOutside) { if (same(e, byOutside)) st.unchanged++; else refreshes.push(byOutside); continue; }
        if (unknown.has(e.sourceId) || unknown.has(e.targetId)) { st.skippedNoVector++; continue; }
        drops.push(e);
    }

    let written = 0;
    let invalidated = 0;
    let keptExisting = 0;
    let skippedMissingEndpoint = 0;
    if (inserts.length > 0) {
        const r = await sub.writeInferred(workspace, graph, inserts);
        st.inserted += r.written; written += r.written; keptExisting += r.keptExisting; skippedMissingEndpoint += r.skippedMissingEndpoint;
    }
    if (refreshes.length > 0) {
        const r = await sub.writeInferred(workspace, graph, refreshes);
        st.refreshed += r.written; written += r.written; keptExisting += r.keptExisting; skippedMissingEndpoint += r.skippedMissingEndpoint;
    }
    if (drops.length > 0) {
        const keys = drops.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId, relation: e.relation }));
        const at = new Date(a.now()).toISOString();
        invalidated = await withEdgeLocks(workspace, keys, () => graph.invalidateEdges!(keys, at));
        st.invalidated += invalidated;
    }
    return { written, invalidated, keptExisting, skippedMissingEndpoint, reused: reusedSets.size };
}
