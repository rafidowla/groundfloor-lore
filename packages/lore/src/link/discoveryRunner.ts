/**
 * discoveryRunner.ts - Links Loop D: the discovery pass (design _lore-3.25-handoff/LINK-BUILDING-AT-SCALE-DESIGN-2026-10-23.md).
 *
 * Arrival linking (Loop A) only probes from the NEW node, so two old nodes that are similar to each other but arrived
 * before either could see the other stay unlinked. Discovery closes that gap with a neighbour-of-neighbour pass over
 * recently changed regions:
 *
 *   seeds  = the next page of nodes (keyset cursor over `bulkList`, updatedAt DESC)
 *   region = seeds + the nodes the seeds link to today
 *   pairs  = what the link policy (same minSim / top-k / dupSim as Loop A) says each region node links to, from STORED
 *            vectors (never re-embeds), minus pairs already linked
 *
 * New pairs are written through the linker's existing batched, caller-safe write path (origin `link_on_arrival`,
 * policy_version and model fingerprint stamped). They are then typed by the cascade (discoveryTyping.ts).
 *
 * Bounded and polite: per-run budgets (nodes, pairs, wall time) are checked between steps; the run stops early and
 * resumes from its durable cursor when the host is busy (link queue, embed queue, outbox). Single-flighted per workspace.
 * A pass covers the whole workspace the first time, then only nodes changed since the previous pass started
 * (minus WATERMARK_OVERLAP_MS, because a vector can commit a little after its node's updatedAt).
 */
import type { BulkListCursor, BulkListPage, BulkListQuery } from '../providers/types.js';
import { edgesTouching, pairKey } from './linkDiff.js';
import type { LinkDiscoveryConfig } from './discoveryConfig.js';
import { emptyDiscoveryState, type DiscoveryState, type DiscoveryStateStore } from './discoveryStore.js';
import { typePairs, type TypingGraph, type TypingPair } from './discoveryTyping.js';
import type { LinkRuntimeConfig } from './linkConfig.js';
import { SEMANTIC_RELATION, type BatchEdgeResult, type DuplicateCandidate, type InferredEdge } from './linkTypes.js';
import type { ProposalStore } from './proposalStore.js';
import type { RulesTyper, TypingCascade, TypingContext } from './relationTyper.js';
import type { ComputedLinks, LinkGraph, LinkHandles } from './storedVectorLinker.js';

/** A node's vector can commit after its updatedAt; the next pass re-reads this much of the previous one. */
export const WATERMARK_OVERLAP_MS = 5 * 60_000;

/** What discovery needs from the StoredVectorLinker. */
export interface DiscoverySubstrate {
    openHandles(workspace: string): Promise<LinkHandles | null>;
    computeLinks(workspace: string, ids: string[]): Promise<ComputedLinks | null>;
    writeInferred(workspace: string, graph: LinkGraph, edges: InferredEdge[]): Promise<BatchEdgeResult>;
}

export type DiscoveryGraph = LinkGraph & TypingGraph & { bulkList?: (q: BulkListQuery) => Promise<BulkListPage> };

export interface DiscoveryRunnerOptions {
    config: LinkDiscoveryConfig;
    linkConfig: Pick<LinkRuntimeConfig, 'dupSim' | 'maxLinksPerNode' | 'k'>;
    linker: DiscoverySubstrate;
    store: DiscoveryStateStore;
    proposals: ProposalStore;
    cascade: TypingCascade;
    rules: RulesTyper;
    /** Policy stamp of the edges written (the linker's own). */
    policyVersion: string;
    /** The supersession-candidates list (the link queue's `link_dup_candidates`). */
    addDuplicates(workspace: string, dups: ReadonlyArray<DuplicateCandidate>, now: number): void;
    /** True while the host is writing/embedding/linking: the run stops and resumes next sweep. */
    isBusy?(workspace: string): boolean | Promise<boolean>;
    /** Awaited before a workspace's run (the service migrates the workspace's durable autolink opt-outs here). */
    prepare?(workspace: string): Promise<void>;
    /** Workspaces a sweep visits. */
    workspaces?(): string[];
    /** Called after edges were written (the cap-prune sweep re-checks the workspace). */
    onWrote?(workspace: string): void;
    now?(): number;
    sleep?(ms: number): Promise<void>;
    onError?(message: string): void;
}

export type DiscoveryStop = 'complete' | 'budget_nodes' | 'budget_pairs' | 'budget_time' | 'busy' | 'no_handles' | 'unsupported' | 'stopped' | 'error';

export interface DiscoveryRunResult {
    workspace: string;
    stop: DiscoveryStop;
    nodes: number;
    pairs: number;
    linksAdded: number;
    supportsAdded: number;
    proposals: number;
    /** True when this run finished a pass (the watermark advanced). */
    passCompleted: boolean;
}

export interface DiscoveryStats {
    enabled: true;
    runs: number;
    passes: number;
    nodesScanned: number;
    pairsScanned: number;
    linksAdded: number;
    supportsAdded: number;
    proposalsRaised: number;
    budgetStops: number;
    pendingProposals: number;
    typers: string[];
    active: number;
    lastRunAt: number | null;
}

const iso = (v: unknown): string => (typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : v == null ? '' : String(v));
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class LinkDiscovery {
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly inFlight = new Map<string, Promise<DiscoveryRunResult>>();
    private stopped = false;

    constructor(private readonly o: DiscoveryRunnerOptions) {
        this.now = o.now ?? Date.now;
        this.sleep = o.sleep ?? ((ms) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    }

    /** Run (or join the run of) one workspace. Never rejects: a failure is a `stop: 'error'` result. */
    run(workspace: string): Promise<DiscoveryRunResult> {
        const cur = this.inFlight.get(workspace);
        if (cur) return cur;
        const p = this.runInner(workspace).catch((err) => {
            this.o.onError?.(`link discovery failed (${workspace}): ${(err as Error).message}`);
            return this.result(workspace, 'error');
        });
        this.inFlight.set(workspace, p.finally(() => { this.inFlight.delete(workspace); }));
        return this.inFlight.get(workspace)!;
    }

    /** One sweep: every workspace once, in order. A busy host ends the sweep (resumes next tick). */
    async sweep(extra: Iterable<string> = []): Promise<DiscoveryRunResult[]> {
        const out: DiscoveryRunResult[] = [];
        for (const ws of [...new Set([...(this.o.workspaces?.() ?? []), ...extra])].sort()) {
            if (this.stopped) break;
            const r = await this.run(ws);
            out.push(r);
            if (r.stop === 'busy') break;
        }
        return out;
    }

    stop(): void { this.stopped = true; }

    async drain(timeoutMs: number): Promise<{ timedOut: boolean }> {
        this.stopped = true;
        if (this.inFlight.size === 0) return { timedOut: false };
        let t: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), timeoutMs); t.unref?.(); });
        try { return { timedOut: (await Promise.race([Promise.all([...this.inFlight.values()]).then(() => 'done' as const), expired])) === 'timeout' }; } finally { if (t) clearTimeout(t); }
    }

    stats(): DiscoveryStats {
        const rows = (() => { try { return this.o.store.list(); } catch { return []; } })();
        const sum = (f: (s: DiscoveryState) => number): number => rows.reduce((n, s) => n + f(s), 0);
        return {
            enabled: true, runs: sum((s) => s.runs), passes: sum((s) => s.passes), nodesScanned: sum((s) => s.nodesScanned), pairsScanned: sum((s) => s.pairsScanned),
            linksAdded: sum((s) => s.linksAdded), supportsAdded: sum((s) => s.supportsAdded), proposalsRaised: sum((s) => s.proposalsRaised), budgetStops: sum((s) => s.budgetStops),
            pendingProposals: (() => { try { return this.o.proposals.counts().pending; } catch { return 0; } })(), typers: this.o.cascade.ids, active: this.inFlight.size,
            lastRunAt: rows.reduce<number | null>((m, s) => (s.lastRunAt !== null && (m === null || s.lastRunAt > m) ? s.lastRunAt : m), null),
        };
    }

    private result(workspace: string, stop: DiscoveryStop): DiscoveryRunResult {
        return { workspace, stop, nodes: 0, pairs: 0, linksAdded: 0, supportsAdded: 0, proposals: 0, passCompleted: false };
    }

    private async runInner(ws: string): Promise<DiscoveryRunResult> {
        const cfg = this.o.config;
        const res = this.result(ws, 'complete');
        await this.o.prepare?.(ws);
        const handles = await this.o.linker.openHandles(ws);
        if (!handles) return { ...res, stop: 'no_handles' };
        const graph = handles.graph as DiscoveryGraph;
        if (typeof graph.bulkList !== 'function' || typeof graph.getNodesByIds !== 'function' || !graph.queryEdges || !graph.addInferredEdgesBatch) return { ...res, stop: 'unsupported' };
        const bulkList = graph.bulkList.bind(graph);

        const started = this.now();
        let st: DiscoveryState = this.o.store.get(ws) ?? emptyDiscoveryState(ws);
        if (!st.passStartedAt) st = { ...st, passStartedAt: new Date(started).toISOString(), cursorUpdatedAt: null, cursorId: null };
        const today = dayOf(started);
        if (st.judgeDay !== today) st = { ...st, judgeDay: today, judgeUsed: 0 };
        let judgeRun = 0;
        let judgeStopCounted = false;
        let budgetStops = 0;
        const j = cfg.judge;
        const ctx: TypingContext = {
            workspace: ws,
            takeBudget: () => {
                if (judgeRun >= j.budgetPerRun || (j.budgetPerDay > 0 && st.judgeUsed >= j.budgetPerDay)) return false;
                judgeRun++; st = { ...st, judgeUsed: st.judgeUsed + 1 };
                return true;
            },
            onBudgetStop: () => { if (!judgeStopCounted) { judgeStopCounted = true; budgetStops++; } },
        };
        const k = Math.max(1, this.o.linkConfig.k);
        const dupFloor = Math.min(this.o.linkConfig.dupSim, cfg.supersedeSim);

        for (;;) {
            if (this.stopped) { res.stop = 'stopped'; break; }
            if (await this.busy(ws)) { res.stop = 'busy'; break; }
            const budget = this.budgetStop(res, started);
            if (budget) { res.stop = budget; budgetStops++; break; }
            const wm = st.watermark;
            const cursor: BulkListCursor | null = st.cursorId !== null && st.cursorUpdatedAt !== null ? { updatedAt: st.cursorUpdatedAt, id: st.cursorId } : null;
            const limit = Math.max(1, Math.min(cfg.seedBatch, cfg.maxNodes - res.nodes, Math.floor((cfg.maxPairs - res.pairs) / (2 * k))));
            let page: BulkListPage;
            let passDone = false;
            let step = { pairs: 0, linksAdded: 0, supportsAdded: 0, proposals: 0 };
            let freshCount = 0;
            try {
                page = await bulkList({ limit, cursor });
                const rows = page.nodes.map((r) => ({ id: String(r.id), updatedAt: iso(r.updatedAt) }));
                const fresh = wm ? rows.filter((r) => r.updatedAt >= wm) : rows;
                passDone = (wm !== null && fresh.length < rows.length) || !page.hasMore || !page.nextCursor || rows.length === 0;
                if (fresh.length > 0) step = await this.step(ws, graph, fresh.map((r) => r.id), dupFloor, ctx);
                freshCount = fresh.length;
                res.nodes += freshCount;
            } catch (err) {
                this.o.onError?.(`link discovery step failed (${ws}): ${(err as Error).message}`);
                res.stop = 'error';
                break;
            }
            res.pairs += step.pairs; res.linksAdded += step.linksAdded; res.supportsAdded += step.supportsAdded; res.proposals += step.proposals;
            st = {
                ...st, nodesScanned: st.nodesScanned + freshCount, pairsScanned: st.pairsScanned + step.pairs, linksAdded: st.linksAdded + step.linksAdded,
                supportsAdded: st.supportsAdded + step.supportsAdded, proposalsRaised: st.proposalsRaised + step.proposals,
            };
            if (passDone) {
                res.passCompleted = true;
                st = { ...st, passes: st.passes + 1, watermark: new Date(Date.parse(st.passStartedAt!) - WATERMARK_OVERLAP_MS).toISOString(), passStartedAt: null, cursorUpdatedAt: null, cursorId: null };
            } else {
                st = { ...st, cursorUpdatedAt: page.nextCursor!.updatedAt, cursorId: page.nextCursor!.id };
            }
            this.o.store.put(st);
            if (passDone) break;
            if (cfg.yieldMs > 0) await this.sleep(cfg.yieldMs);
        }
        if (res.nodes > 0 || budgetStops > 0) {
            this.o.store.put({ ...st, runs: st.runs + (res.nodes > 0 ? 1 : 0), budgetStops: st.budgetStops + budgetStops, lastRunAt: this.now() });
        }
        return res;
    }

    private budgetStop(r: DiscoveryRunResult, started: number): DiscoveryStop | null {
        const c = this.o.config;
        if (r.nodes >= c.maxNodes) return 'budget_nodes';
        if (r.pairs >= c.maxPairs) return 'budget_pairs';
        if (this.now() - started >= c.maxMs) return 'budget_time';
        return null;
    }

    private async busy(ws: string): Promise<boolean> {
        try { return (await this.o.isBusy?.(ws)) === true; } catch { return false; }
    }

    /** One step over a page of seeds. Returns what it did. */
    private async step(ws: string, graph: DiscoveryGraph, seeds: string[], dupFloor: number, ctx: TypingContext): Promise<{ pairs: number; linksAdded: number; supportsAdded: number; proposals: number }> {
        const out = { pairs: 0, linksAdded: 0, supportsAdded: 0, proposals: 0 };
        const seedLinks = await this.o.linker.computeLinks(ws, seeds);
        if (!seedLinks) return out;
        const cand = new Map<string, InferredEdge>();
        const take = (c: ComputedLinks): void => {
            for (const edges of c.bySource.values()) for (const e of edges) {
                const key = pairKey(e.sourceId, e.targetId);
                const prev = cand.get(key);
                if (!prev || e.confidenceScore > prev.confidenceScore) cand.set(key, e);
            }
        };
        take(seedLinks);
        const seedSet = new Set(seeds);
        const neighbours = new Set<string>();
        for (const e of cand.values()) for (const id of [e.sourceId, e.targetId]) if (!seedSet.has(id)) neighbours.add(id);
        if (neighbours.size > 0) {
            const nl = await this.o.linker.computeLinks(ws, [...neighbours]);
            if (nl) take(nl);
        }
        out.pairs = cand.size;
        if (cand.size === 0) return out;

        // Pairs already linked (any origin, live) are not rewritten: a caller edge is never touched, and an edge the
        // refresh / prune soft-invalidated is not revived over their back.
        const endpoints = [...new Set([...cand.values()].flatMap((e) => [e.sourceId, e.targetId]))];
        const live = await edgesTouching(graph, endpoints);
        const cap = this.o.linkConfig.maxLinksPerNode;
        const degree = new Map<string, number>();
        if (cap > 0) for (const e of live.values()) if (e.provenance?.origin === 'link_on_arrival') for (const id of [e.sourceId, e.targetId]) degree.set(id, (degree.get(id) ?? 0) + 1);

        const fresh: InferredEdge[] = [];
        const pairs: TypingPair[] = [];
        const dups: DuplicateCandidate[] = [];
        for (const e of [...cand.values()].sort((a, b) => b.confidenceScore - a.confidenceScore || (a.sourceId + a.targetId).localeCompare(b.sourceId + b.targetId))) {
            const isNew = !live.has(pairKey(e.sourceId, e.targetId));
            if (isNew && cap > 0 && ((degree.get(e.sourceId) ?? 0) >= cap || (degree.get(e.targetId) ?? 0) >= cap)) continue;
            if (isNew) {
                fresh.push({ ...e, relation: SEMANTIC_RELATION });
                degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1); degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
            }
            if (e.confidenceScore >= dupFloor) dups.push({ a: e.sourceId, b: e.targetId, score: e.confidenceScore });
            if (isNew || e.confidenceScore >= this.o.config.supersedeSim) pairs.push({ lo: e.sourceId, hi: e.targetId, score: e.confidenceScore, isNew });
        }
        if (fresh.length > 0) {
            const w = await this.o.linker.writeInferred(ws, graph, fresh);
            out.linksAdded = w.written;
            if (w.written > 0) this.o.onWrote?.(ws);
        }
        if (dups.length > 0) this.o.addDuplicates(ws, dups, this.now());
        const typed = await typePairs({
            workspace: ws, graph, cascade: this.o.cascade, rules: this.o.rules, proposals: this.o.proposals, policyVersion: this.o.policyVersion,
            now: this.now, ctx, write: async (edges) => { const r = await this.o.linker.writeInferred(ws, graph, edges); if (r.written > 0) this.o.onWrote?.(ws); return r; },
        }, pairs);
        out.supportsAdded = typed.supportsAdded;
        out.proposals = typed.proposalsRaised;
        return out;
    }
}
