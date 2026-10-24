/**
 * storedVectorLinker.ts - the engine-neutral `Linker` (link-on-arrival).
 *
 * Links an arriving node from its STORED vector: no text is embedded again
 * (the legacy autolink embedded every node a second time as a query). One
 * batched kNN for the whole batch, threshold + top-k selection, then ONE
 * batched edge write. Caller-supplied edges are never touched: the batch write
 * only refreshes rows that are themselves `inferred`.
 *
 * Confinement carried over from the legacy hook, plus the one rule a
 * background worker needs: it runs with no actor, so row-level scopes are
 * enforced by EQUAL scope sets between the arriving node and each neighbour
 * (a scoped node only ever links to nodes with the identical scope set, and a
 * public node only to public nodes) - an edge can never reveal that a node the
 * reader cannot see exists.
 *
 * Opt-out (`autolink:false`, durable in the workspace store; see linkTypes.ts LinkOptOutCapable), BOTH directions:
 * an opted-out arriving node is skipped as a source (no vector read, counted done), and an opted-out node is
 * dropped from every other node's neighbour hits. Because dropping hits could shrink a node's links below top-k,
 * a node whose raw neighbour list was saturated, lost hits to opt-outs, and still has fewer than k eligible
 * hits above the threshold is re-queried with a wider kNN (x3, capped, bounded rounds); see eligibleNeighbours().
 */
import {
    ambiguousHitAllowed, ecosystemConfinement, hitEcosystemVerdict,
    type NodeReader,
} from '../engines/reconnect.js';
import { withEdgeLocks } from '../core/nodeWriteLock.js';
import { normalizeScopes } from '../security/scopeFilter.js';
import type { EdgeKey, EdgeProvenance, EdgeQuery, LoreEdge, VerbatimSearchResult } from '../providers/types.js';
import type { LinkPolicy } from './linkConfig.js';
import { nodeIdOfRow, selectLinks } from './selectLinks.js';
import { emptyDiffCounters, reconcileLinks } from './linkDiff.js';
import {
    SEMANTIC_RELATION,
    hasLinkOptOutSupport,
    type BatchEdgeResult, type DuplicateCandidate, type InferredEdge, type InferredEdgeBatchCapable, type LinkOptOutCapable, type LinkEdgeStatsCapable,
    type KnnOptions, type KnnQuery, type LinkBatchResult, type LinkItem, type Linker,
} from './linkTypes.js';

/** The slice of a workspace's verbatim store the linker reads. */
export interface LinkVerbatim {
    getVectors(ids: string[]): Promise<Map<string, number[]>>;
    getById(id: string): Promise<{ ecosystem?: string; security_scopes?: string[] } | null>;
    searchByVector(vector: number[], opts?: { topK?: number; filter?: Record<string, unknown>; actorScopes?: ReadonlyArray<string> }): Promise<VerbatimSearchResult[]>;
    searchByVectors?(queries: KnnQuery[], opts: KnnOptions): Promise<Map<string, VerbatimSearchResult[]>>;
    /** Every stored row id with the prefix (the rebuild enumerates `lore:`); absent on stores that cannot list. */
    listIds?(prefix?: string): Promise<string[]>;
}

/** The slice of a workspace's graph the linker writes through. */
export type LinkGraph = NodeReader & Partial<InferredEdgeBatchCapable> & Partial<LinkOptOutCapable> & Partial<LinkEdgeStatsCapable> & {
    /** Rebuild only: read live edges with provenance, and soft-invalidate dropped ones. */
    queryEdges?(q: EdgeQuery): Promise<LoreEdge[]>;
    invalidateEdges?(edgeKeys: EdgeKey[], at: string): Promise<number>;
    addEdge(edge: { sourceId: string; targetId: string; relation: string; confidence: 'inferred'; confidenceScore: number; provenance?: EdgeProvenance }): Promise<unknown>;
};

/** What the rebuild needs to know about a set of nodes' current link sets. */
export interface ComputedLinks {
    /** Source node id -> the edges it would get today (a node with no neighbour above the threshold maps to []). */
    bySource: Map<string, InferredEdge[]>;
    /** No stored row: the node is gone. */
    gone: string[];
    /** Row without a vector: its link set is UNKNOWN (never treat as empty). */
    noVector: string[];
    /** Opted out (`autolink:false`): never a link source or target; the rebuild leaves their existing edges alone. */
    optedOut: string[];
}

export interface LinkHandles { graph: LinkGraph; verbatim: LinkVerbatim }
export type LinkHandleResolver = (workspace: string) => Promise<LinkHandles | null>;

const ROW_PREFIX = 'lore:';
/** Over-fetch so confinement filters (ecosystem, scope, history) cannot starve the top-k. */
const overfetch = (k: number): number => Math.min(50, k * 3 + 1);
/** Widening for opt-out crowding: kNN depth multiplier, hard cap, and extra rounds (worst case ~4 kNN passes for a pathologically crowded node). */
const WIDEN_FACTOR = 3;
const WIDEN_CAP = 400;
const WIDEN_ROUNDS = 3;

/** True for the all-zero (or non-finite) placeholder a skip/queued bulk load writes before the real embedding. */
export function isPlaceholderVector(v: ArrayLike<number>): boolean {
    for (let i = 0; i < v.length; i++) {
        const x = v[i]!;
        if (!Number.isFinite(x)) return true;
        if (x !== 0) return false;
    }
    return true;
}

function scopeKey(raw: unknown): string {
    return [...new Set(normalizeScopes(raw))].sort().join('\u0000');
}

function mergeHits(into: Map<string, VerbatimSearchResult[]>, from: Map<string, VerbatimSearchResult[]>): void {
    for (const [key, hits] of from) {
        const cur = into.get(key);
        if (!cur) { into.set(key, [...hits]); continue; }
        const seen = new Set(cur.map((h) => h.id));
        for (const h of hits) if (!seen.has(h.id)) cur.push(h);
        cur.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }
}

export class StoredVectorLinker implements Linker {
    /** `modelFingerprint` = embeddingProviderFingerprint() of the provider that embedded the vectors; stamped on every edge. */
    constructor(private readonly resolve: LinkHandleResolver, private readonly policy: LinkPolicy, private readonly modelFingerprint: string | null = null) {}

    /** Provenance stamped on every edge this linker writes (edge provenance, design D3). */
    private provenance(): EdgeProvenance {
        return { origin: 'link_on_arrival', policyVersion: this.policy.policyVersion, modelFingerprint: this.modelFingerprint };
    }

    async linkBatch(workspace: string, items: LinkItem[]): Promise<LinkBatchResult> {
        const out: LinkBatchResult = { done: [], retry: [], edgesWritten: 0, keptExisting: 0, skippedMissingEndpoint: 0, duplicates: [] };
        if (items.length === 0) return out;
        const handles = await this.resolve(workspace).catch(() => null);
        if (!handles) {
            for (const it of items) out.retry.push({ id: it.id, reason: 'no_handles' });
            return out;
        }
        const sel = await this.selectFor(handles, items);
        out.done.push(...sel.gone, ...sel.optedOut);
        out.retry.push(...sel.noVector.map((id) => ({ id, reason: 'no_vector' })));
        const edges = [...sel.bySource.values()].flat();
        const wrote = await this.writeEdges(workspace, handles.graph, edges);
        out.edgesWritten = wrote.written;
        out.keptExisting = wrote.keptExisting;
        out.skippedMissingEndpoint = wrote.skippedMissingEndpoint;
        out.duplicates = sel.duplicates;
        for (const id of sel.bySource.keys()) out.done.push(id);
        return out;
    }

    /**
     * Loop B: refresh the links of nodes whose content or vector just changed. Same selection as `linkBatch`, but
     * the result is reconciled as a DIFF (see linkDiff.ts): new neighbours are linked AND `link_on_arrival` edges
     * that no longer qualify are soft-invalidated (`valid_to`, never deleted), unless the OTHER endpoint still
     * wants them. Opted-out nodes keep their edges. Falls back to `linkBatch` on an engine that cannot diff.
     */
    async refreshBatch(workspace: string, items: LinkItem[]): Promise<LinkBatchResult> {
        const handles = items.length === 0 ? null : await this.resolve(workspace).catch(() => null);
        const g = handles?.graph;
        if (!handles || !g?.queryEdges || !g.invalidateEdges || !g.addInferredEdgesBatch) return this.linkBatch(workspace, items);
        const out: LinkBatchResult = { done: [], retry: [], edgesWritten: 0, keptExisting: 0, skippedMissingEndpoint: 0, duplicates: [], invalidated: 0, refreshed: 0, wroteEdges: false };
        const sel = await this.selectFor(handles, items);
        out.done.push(...sel.gone, ...sel.optedOut);
        out.retry.push(...sel.noVector.map((id) => ({ id, reason: 'no_vector' })));
        out.duplicates = sel.duplicates;
        const batch = [...sel.bySource.keys()];
        if (batch.length > 0) {
            const counters = emptyDiffCounters();
            const computed: ComputedLinks = { bySource: sel.bySource, gone: sel.gone, noVector: sel.noVector, optedOut: sel.optedOut };
            const res = await reconcileLinks({ workspace, graph: g, sub: this, batch, computed, owns: () => true, now: Date.now, counters });
            out.edgesWritten = res.written;
            out.keptExisting = res.keptExisting;
            out.skippedMissingEndpoint = res.skippedMissingEndpoint;
            out.invalidated = res.invalidated;
            out.refreshed = counters.refreshed;
            out.wroteEdges = res.written > 0 || res.invalidated > 0;
            out.done.push(...batch);
        }
        return out;
    }

    /**
     * Compute (never write) the link set each of `ids` would get today, from its stored vector. Used by the
     * rebuild. Returns null when the workspace cannot be opened. `gone` = no stored row; `noVector` = row but no vector.
     */
    async computeLinks(workspace: string, ids: string[]): Promise<ComputedLinks | null> {
        const handles = await this.resolve(workspace).catch(() => null);
        if (!handles) return null;
        const sel = await this.selectFor(handles, ids.map((id) => ({ id })));
        return { bySource: sel.bySource, gone: sel.gone, noVector: sel.noVector, optedOut: sel.optedOut };
    }

    /** Graph + verbatim handles for the rebuild; null when the workspace cannot be opened. */
    openHandles(workspace: string): Promise<LinkHandles | null> { return this.resolve(workspace).catch(() => null); }

    /** Provenance this linker stamps today (policy version + model fingerprint), for the rebuild's unchanged check. */
    currentStamp(): { policyVersion: string; modelFingerprint: string | null } {
        return { policyVersion: this.policy.policyVersion, modelFingerprint: this.modelFingerprint };
    }

    /** The batched, locked, caller-edge-safe write shared with arrival linking. */
    writeInferred(workspace: string, graph: LinkGraph, edges: InferredEdge[]): Promise<BatchEdgeResult> {
        return this.writeEdges(workspace, graph, edges);
    }

    /** Stored vectors -> threshold + top-k per source, with the confinement filters. Pure read. */
    private async selectFor(handles: LinkHandles, items: LinkItem[]): Promise<{
        bySource: Map<string, InferredEdge[]>; gone: string[]; noVector: string[]; optedOut: string[]; duplicates: DuplicateCandidate[];
    }> {
        const { graph, verbatim } = handles;
        const bySource = new Map<string, InferredEdge[]>();
        const gone: string[] = [];
        const noVector: string[] = [];
        const duplicates: DuplicateCandidate[] = [];
        const optedOut: string[] = [];
        if (items.length === 0) return { bySource, gone, noVector, optedOut, duplicates };

        // Opted-out sources first: no vector read, no kNN. Reported separately so callers can tell "skipped on purpose" from "gone".
        const optedOutSources = hasLinkOptOutSupport(graph) ? await graph.getLinkOptOuts(items.map((i) => i.id)) : new Set<string>();
        if (optedOutSources.size > 0) {
            for (const it of items) if (optedOutSources.has(it.id)) optedOut.push(it.id);
            items = items.filter((it) => !optedOutSources.has(it.id));
            if (items.length === 0) return { bySource, gone, noVector, optedOut, duplicates };
        }

        const vectors = await verbatim.getVectors(items.map((i) => ROW_PREFIX + i.id));
        const ready: Array<{ id: string; vector: number[]; ecosystem: string; scopes: string }> = [];
        for (const it of items) {
            const row = await verbatim.getById(ROW_PREFIX + it.id);
            if (!row) { gone.push(it.id); continue; } // node (or its row) is gone: nothing to link
            const vector = vectors.get(ROW_PREFIX + it.id);
            if (!vector || vector.length === 0) { noVector.push(it.id); continue; }
            // A placeholder (all-zero) vector - `/api/load` embed=skip / queued rows before their real embed - has no
            // direction: every neighbour score is 0 or NaN, and a store that ranks zeros first would link arbitrary
            // rows. It is "not embedded yet", exactly like a missing vector: retry (bounded) until the real one lands.
            if (isPlaceholderVector(vector)) { noVector.push(it.id); continue; }
            ready.push({ id: it.id, vector, ecosystem: row.ecosystem ?? it.ecosystem ?? '', scopes: scopeKey(row.security_scopes) });
        }
        if (ready.length === 0) return { bySource, gone, noVector, optedOut, duplicates };

        const hitsByKey = await this.eligibleNeighbours(graph, verbatim, ready);
        const resolvedEco = new Map<string, string>();
        for (const src of ready) {
            const { scope, scoped } = ecosystemConfinement(src.ecosystem);
            const kept: Array<{ id: string; score: number }> = [];
            for (const hit of hitsByKey.get(src.id) ?? []) {
                if (scopeKey(hit.metadata?.security_scopes) !== src.scopes) continue;
                if (scoped) {
                    const verdict = hitEcosystemVerdict(hit, scope);
                    if (verdict === 'outside') continue;
                    if (verdict === 'unknown' && !await ambiguousHitAllowed(graph, hit.id, scope, resolvedEco)) continue;
                }
                kept.push({ id: hit.id, score: hit.score ?? 0 });
            }
            const sel = selectLinks(src.id, kept, this.policy);
            bySource.set(src.id, sel.edges.map((e) => ({ ...e, provenance: this.provenance() })));
            duplicates.push(...sel.duplicates);
        }
        return { bySource, gone, noVector, optedOut, duplicates };
    }

    /**
     * `neighbours()` minus opted-out nodes, without letting the removal shrink a node below top-k.
     * One batched PK lookup per round covers every candidate node id of the batch (cached across rounds). A
     * source is re-queried at a wider depth only when ALL hold: it lost at least one hit to an opt-out, it has
     * fewer than k eligible hits at/above the threshold, its raw list was saturated (>= topK), and the raw
     * list's lowest score still clears the threshold (so more eligible neighbours may sit beyond the cut).
     * With no opt-outs among the hits - the common case - this is exactly one lookup and no extra kNN.
     */
    private async eligibleNeighbours(
        graph: LinkGraph, verbatim: LinkVerbatim,
        ready: Array<{ id: string; vector: number[]; ecosystem: string }>,
    ): Promise<Map<string, VerbatimSearchResult[]>> {
        if (!hasLinkOptOutSupport(graph)) return this.neighbours(verbatim, ready, overfetch(this.policy.k));
        const out = new Map<string, VerbatimSearchResult[]>();
        const flagged = new Map<string, boolean>(); // candidate node id -> opted out
        let pending = ready;
        let topK = overfetch(this.policy.k);
        for (let round = 0; pending.length > 0; round++) {
            const hits = await this.neighbours(verbatim, pending, topK);
            const unseen = new Set<string>();
            for (const list of hits.values()) for (const h of list) {
                const n = nodeIdOfRow(h.id);
                if (n !== null && !flagged.has(n)) unseen.add(n);
            }
            if (unseen.size > 0) {
                const hit = await graph.getLinkOptOuts([...unseen]);
                for (const n of unseen) flagged.set(n, hit.has(n));
            }
            const retry: typeof pending = [];
            for (const src of pending) {
                const raw = hits.get(src.id) ?? [];
                const kept = raw.filter((h) => { const n = nodeIdOfRow(h.id); return n === null || !flagged.get(n); });
                out.set(src.id, kept);
                if (kept.length === raw.length || round >= WIDEN_ROUNDS || topK >= WIDEN_CAP) continue;
                const eligible = new Set<string>();
                for (const h of kept) {
                    const n = nodeIdOfRow(h.id);
                    if (n !== null && n !== src.id && (h.score ?? 0) >= this.policy.minSim) eligible.add(n);
                }
                if (eligible.size >= this.policy.k) continue;
                const lowest = raw.reduce((m, h) => Math.min(m, h.score ?? 0), Infinity);
                if (raw.length >= topK && lowest >= this.policy.minSim) retry.push(src);
            }
            pending = retry;
            topK = Math.min(WIDEN_CAP, topK * WIDEN_FACTOR);
        }
        return out;
    }

    /** Batched kNN: one unscoped pass for everything + one scoped pass per concrete ecosystem, unioned. */
    private async neighbours(
        verbatim: LinkVerbatim,
        ready: Array<{ id: string; vector: number[]; ecosystem: string }>,
        topK: number,
    ): Promise<Map<string, VerbatimSearchResult[]>> {
        const all = new Map<string, VerbatimSearchResult[]>();
        mergeHits(all, await this.knn(verbatim, ready.map((r) => ({ key: r.id, vector: r.vector })), { topK }));
        const byEco = new Map<string, KnnQuery[]>();
        for (const r of ready) {
            const { scope, scoped } = ecosystemConfinement(r.ecosystem);
            if (!scoped) continue;
            const list = byEco.get(scope) ?? [];
            list.push({ key: r.id, vector: r.vector });
            byEco.set(scope, list);
        }
        for (const [eco, queries] of byEco) {
            mergeHits(all, await this.knn(verbatim, queries, { topK, filter: { ecosystem: eco } }));
        }
        return all;
    }

    private async knn(verbatim: LinkVerbatim, queries: KnnQuery[], opts: KnnOptions): Promise<Map<string, VerbatimSearchResult[]>> {
        if (verbatim.searchByVectors) return verbatim.searchByVectors(queries, opts);
        const out = new Map<string, VerbatimSearchResult[]>();
        for (const q of queries) out.set(q.key, await verbatim.searchByVector(q.vector, { topK: opts.topK, filter: opts.filter }));
        return out;
    }

    private async writeEdges(workspace: string, graph: LinkGraph, edges: InferredEdge[]): Promise<BatchEdgeResult> {
        const none: BatchEdgeResult = { written: 0, skippedMissingEndpoint: 0, keptExisting: 0 };
        if (edges.length === 0) return none;
        const triples = edges.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId, relation: e.relation }));
        return withEdgeLocks(workspace, triples, async () => {
            if (graph.addInferredEdgesBatch) return graph.addInferredEdgesBatch(edges);
            // Engine without the batch method: legacy per-edge write. It cannot protect a caller-supplied
            // edge on the same triple, so an engine meant for link-on-arrival must implement the batch method.
            const res = { ...none };
            for (const e of edges) {
                try {
                    await graph.addEdge({ sourceId: e.sourceId, targetId: e.targetId, relation: SEMANTIC_RELATION, confidence: 'inferred', confidenceScore: e.confidenceScore, provenance: e.provenance });
                    res.written++;
                } catch { res.skippedMissingEndpoint++; }
            }
            return res;
        });
    }
}
