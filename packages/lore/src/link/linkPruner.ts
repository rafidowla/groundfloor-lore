/**
 * linkPruner.ts - the soft per-node link cap, enforced in the background (link freshness, P1).
 *
 * With `maxLinksPerNode = C > 0`, a node keeps its C STRONGEST live `link_on_arrival` edges; the weaker ones are
 * soft-invalidated (`valid_to`, never deleted). It never runs inline with a write: writers mark the workspace
 * dirty, and a timer sweep (LinkService) scans for nodes over the cap and trims them.
 *
 * Rules (each has a test in link-prune-unit.ts):
 *   - Only `link_on_arrival` edges are counted and evictable; caller / import / legacy edges are never touched.
 *   - A node that opted out of linking (`autolink:false`) keeps all its links, and an edge to an opted-out node
 *     is never evicted from the other side either.
 *   - An edge that is the OTHER endpoint's strongest link is never evicted (the cap must not isolate a node).
 *     A hub whose weak edges are all protected this way stays above the cap; that is the intended trade.
 *   - Resumable: a pass walks over-cap nodes in id order and checkpoints its cursor after each batch.
 *   - Eventual, not absolute: a pruned pair can be re-asserted by a later link or rebuild, and is trimmed again
 *     by the next pass.
 */
import { withEdgeLocks } from '../core/nodeWriteLock.js';
import type { LoreEdge } from '../providers/types.js';
import { edgesTouching, pairKey } from './linkDiff.js';
import type { PruneState, PruneStateStore } from './linkPruneStore.js';
import { hasLinkOptOutSupport, type LinkEdgeStatsCapable } from './linkTypes.js';
import type { LinkGraph, LinkHandles } from './storedVectorLinker.js';

export interface PrunerOptions {
    store: PruneStateStore;
    resolveHandles: (workspace: string) => Promise<LinkHandles | null>;
    /** Links allowed per node; 0 disables pruning. Read each pass so a host can change it live. */
    cap: () => number;
    /** Over-cap nodes handled per checkpointed batch. */
    batchSize: number;
    /** True while ingestion / linking is busy: a sweep stops early and resumes next tick. */
    isBusy?: () => boolean;
    now?: () => number;
    onError?: (message: string) => void;
}

export interface PruneResult { evicted: number; nodesTrimmed: number; complete: boolean }

type PruneGraph = LinkGraph & LinkEdgeStatsCapable;
const canPrune = (g: LinkGraph | undefined): g is PruneGraph =>
    !!g && typeof g.linkNodesOverCap === 'function' && !!g.queryEdges && !!g.invalidateEdges;

const isOurs = (e: LoreEdge): boolean => e.provenance?.origin === 'link_on_arrival';
const other = (e: LoreEdge, id: string): string => (e.sourceId === id ? e.targetId : e.sourceId);
/** Strongest first; ties broken by the other endpoint's id so the order is deterministic. */
const byStrength = (id: string) => (a: LoreEdge, b: LoreEdge): number =>
    (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0) || (other(a, id) < other(b, id) ? -1 : other(a, id) > other(b, id) ? 1 : 0);

export class LinkPruner {
    private readonly now: () => number;
    private readonly inFlight = new Map<string, Promise<PruneResult>>();
    /** Bumped on every markDirty so a pass that raced a write does not clear the dirty flag. */
    private readonly writeSeq = new Map<string, number>();
    private stopped = false;

    constructor(private readonly o: PrunerOptions) { this.now = o.now ?? Date.now; }

    markDirty(workspace: string): void {
        if (this.o.cap() <= 0) return;
        this.writeSeq.set(workspace, (this.writeSeq.get(workspace) ?? 0) + 1);
        try { this.o.store.markDirty(workspace); } catch { /* store closed (shutdown) */ }
    }

    stop(): void { this.stopped = true; }

    states(): PruneState[] { try { return this.o.store.list(); } catch { return []; } }

    dirtyWorkspaces(): string[] { return this.o.store.list().filter((s) => s.dirty).map((s) => s.workspace); }

    /** One sweep: continue the pass of every dirty workspace. Stops early (resumable) when busy or stopped. */
    async sweep(): Promise<PruneResult> {
        const total: PruneResult = { evicted: 0, nodesTrimmed: 0, complete: true };
        if (this.o.cap() <= 0) return total;
        for (const ws of this.dirtyWorkspaces()) {
            if (this.stopped || this.o.isBusy?.()) { total.complete = false; break; }
            const r = await this.prune(ws);
            total.evicted += r.evicted; total.nodesTrimmed += r.nodesTrimmed; total.complete &&= r.complete;
        }
        return total;
    }

    /** Run (or join) one workspace's pass. Never rejects. */
    prune(workspace: string): Promise<PruneResult> {
        const live = this.inFlight.get(workspace);
        if (live) return live;
        const p = this.pass(workspace).catch((err): PruneResult => {
            this.o.onError?.(`link prune failed (${workspace}): ${(err as Error).message}`);
            return { evicted: 0, nodesTrimmed: 0, complete: false };
        }).finally(() => { this.inFlight.delete(workspace); });
        this.inFlight.set(workspace, p);
        return p;
    }

    async drain(): Promise<void> { await Promise.all([...this.inFlight.values()]); }

    private async pass(workspace: string): Promise<PruneResult> {
        const res: PruneResult = { evicted: 0, nodesTrimmed: 0, complete: false };
        const cap = Math.floor(this.o.cap());
        if (cap <= 0) { res.complete = true; return res; }
        const handles = await this.o.resolveHandles(workspace);
        const graph = handles?.graph;
        if (!canPrune(graph)) { res.complete = true; return res; }
        const seqAtStart = this.writeSeq.get(workspace) ?? 0;
        const st: PruneState = this.o.store.get(workspace) ?? { workspace, dirty: true, cursor: null, evicted: 0, passes: 0, lastPassAt: null };
        const base = st.evicted;
        for (;;) {
            if (this.stopped) return res;
            const ids = await graph.linkNodesOverCap(cap, this.o.batchSize, st.cursor);
            if (ids.length === 0) break;
            for (const id of ids) {
                const n = await this.trimNode(workspace, graph, id, cap);
                if (n > 0) { res.evicted += n; res.nodesTrimmed++; }
            }
            st.cursor = ids[ids.length - 1]!;
            st.evicted = base + res.evicted;
            this.o.store.put(st);
            if (this.o.isBusy?.()) return res; // resume from the checkpoint next sweep
        }
        st.cursor = null; st.passes++; st.lastPassAt = this.now();
        st.dirty = (this.writeSeq.get(workspace) ?? 0) !== seqAtStart; // a write raced the pass: scan again
        this.o.store.put(st);
        res.complete = true;
        return res;
    }

    /** Trim one node to its `cap` strongest links. Returns how many edges were soft-invalidated. */
    private async trimNode(workspace: string, graph: PruneGraph, id: string, cap: number): Promise<number> {
        const optOuts = (ids: string[]): Promise<Set<string>> => hasLinkOptOutSupport(graph) ? graph.getLinkOptOuts(ids) : Promise.resolve(new Set<string>());
        if ((await optOuts([id])).has(id)) return 0;
        const mine = [...(await edgesTouching(graph, [id])).values()].filter(isOurs).sort(byStrength(id));
        if (mine.length <= cap) return 0;
        const extras = mine.slice(cap);
        const peers = extras.map((e) => other(e, id));
        const peerOptOut = await optOuts(peers);
        const drops: LoreEdge[] = [];
        for (const e of extras) {
            const m = other(e, id);
            if (peerOptOut.has(m)) continue;
            // Protect an edge that is the peer's strongest link: trimming it would leave the peer isolated.
            const theirs = [...(await edgesTouching(graph, [m])).values()].filter(isOurs).sort(byStrength(m));
            if (theirs[0] && pairKey(theirs[0].sourceId, theirs[0].targetId) === pairKey(e.sourceId, e.targetId)) continue;
            drops.push(e);
        }
        if (drops.length === 0) return 0;
        const keys = drops.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId, relation: e.relation }));
        const at = new Date(this.now()).toISOString();
        const invalidate = graph.invalidateEdges!.bind(graph);
        return withEdgeLocks(workspace, keys, () => invalidate(keys, at));
    }
}
