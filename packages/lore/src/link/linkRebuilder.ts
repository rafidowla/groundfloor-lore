/**
 * linkRebuilder.ts - rebuild a workspace's links as a DIFF (Loop C / D2).
 *
 * Walks every node of one workspace in sorted-id order, recomputes the link set it would get today from its
 * STORED vector (no re-embedding) and reconciles it with the live `link_on_arrival` edges:
 *
 *   wanted, absent          -> inserted
 *   wanted, present, stale  -> refreshed in place (policy / model stamp or score changed)
 *   wanted, present, same   -> unchanged (NOT written)
 *   present, wanted by nobody -> soft-invalidated (`valid_to`), never deleted
 *
 * Safety rules (each has a test):
 *   - A node that opted out of linking (`autolink:false`, durable) is skipped as a link source AND as a link
 *     target: it gets no new links, nobody gets a link to it, and its existing links are left as they are
 *     (neither refreshed nor invalidated; counted in `skippedOptOut`).
 *   - Only edges whose origin is exactly `link_on_arrival` are ever invalidated. Caller, import, reconnect,
 *     discovery and legacy NULL-origin edges are untouched; a wanted pair they already hold is left alone.
 *   - An edge is dropped only when NEITHER endpoint wants it, judged from a FRESH recompute of the endpoint
 *     outside the current batch (kNN is asymmetric: A may not list B while B lists A), so a concurrent arrival
 *     can never lose a link it just earned. An endpoint with no stored vector is "unknown", never "empty".
 *   - Old links keep serving reads until replaced: nothing is cleared up front.
 *   - Durable: the cursor is checkpointed after every batch, so a restart resumes where it stopped.
 *   - Throttled: one batch, then `yieldMs`; while the link queue / ingestion is busy it waits (bounded by
 *     `maxWaitMs`, so a never-quiet system still makes progress).
 */
import type { LoreEdge } from '../providers/types.js';
import { nodeIdOfRow, sortedPair } from './selectLinks.js';
import { reconcileLinks } from './linkDiff.js';
import type { BatchEdgeResult, InferredEdge } from './linkTypes.js';
import type { ComputedLinks, LinkGraph, LinkHandles } from './storedVectorLinker.js';
import type { RebuildState, RebuildStateStore } from './linkRebuildStore.js';

export interface RebuildSubstrate {
    openHandles(workspace: string): Promise<LinkHandles | null>;
    computeLinks(workspace: string, ids: string[]): Promise<ComputedLinks | null>;
    currentStamp(): { policyVersion: string; modelFingerprint: string | null };
    writeInferred(workspace: string, graph: LinkGraph, edges: InferredEdge[]): Promise<BatchEdgeResult>;
}

export interface RebuilderOptions {
    store: RebuildStateStore;
    substrate: RebuildSubstrate;
    /** Nodes per batch. */
    batchSize: number;
    /** Pause between batches. */
    yieldMs: number;
    /** Longest a batch waits for `isBusy()` to clear before running anyway. */
    maxWaitMs: number;
    /** True while the link queue has a backlog or ingestion is in flight. */
    isBusy: () => boolean;
    now?: () => number;
    onError?: (message: string) => void;
    /** Called after a batch inserted, refreshed or invalidated links (the cap-prune sweep re-checks the workspace). */
    onWrote?: (workspace: string) => void;
    sleep?: (ms: number) => Promise<void>;
}

export interface RebuildStats {
    active: number;
    /** Times a batch waited because the link queue / ingestion was busy. */
    busyWaits: number;
    runs: RebuildState[];
}

interface Control { stop: false | 'cancel' | 'seal' }

const BUSY_POLL_MS = 50;

export class LinkRebuilder {
    private readonly o: RebuilderOptions;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly active = new Map<string, { ctl: Control; done: Promise<void> }>();
    private busyWaits = 0;
    private sealed = false;
    private seq = 0;

    constructor(o: RebuilderOptions) {
        this.o = o;
        this.now = o.now ?? Date.now;
        // Short pauses only (<= BUSY_POLL_MS / yieldMs): left ref'd so a run in flight is never silently abandoned by an idle event loop.
        this.sleep = o.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));
    }

    /**
     * Start (or resume) the rebuild of one workspace. Idempotent while a run is active. A `running` or `failed`
     * checkpoint made under the same policy + model resumes after its cursor; anything else starts fresh.
     */
    async start(workspace: string): Promise<{ state: RebuildState; resumed: boolean; alreadyRunning: boolean }> {
        const live = this.active.get(workspace);
        const prior = this.o.store.get(workspace);
        if (live && prior) return { state: prior, resumed: false, alreadyRunning: true };
        if (this.sealed) throw new Error('rebuild_sealed');
        const handles = await this.o.substrate.openHandles(workspace);
        if (!handles) throw new Error('workspace_unavailable');
        if (typeof handles.verbatim.listIds !== 'function') throw new Error('rebuild_unsupported: verbatim store cannot list ids');
        if (!handles.graph.queryEdges || !handles.graph.invalidateEdges || !handles.graph.addInferredEdgesBatch) {
            throw new Error('rebuild_unsupported: graph engine lacks queryEdges / invalidateEdges / addInferredEdgesBatch');
        }
        const stamp = this.o.substrate.currentStamp();
        const resumable = prior && (prior.status === 'running' || prior.status === 'failed')
            && prior.policyVersion === stamp.policyVersion && prior.modelFingerprint === stamp.modelFingerprint;
        const state: RebuildState = resumable
            ? { ...prior, status: 'running', finishedAt: null, lastError: null }
            : {
                workspace, runId: `rb-${this.now().toString(36)}-${++this.seq}`, status: 'running', startedAt: this.now(), finishedAt: null,
                policyVersion: stamp.policyVersion, modelFingerprint: stamp.modelFingerprint, cursor: null,
                total: 0, done: 0, inserted: 0, refreshed: 0, invalidated: 0, unchanged: 0, keptForeign: 0, skippedNoVector: 0, skippedOptOut: 0, lastError: null,
            };
        this.o.store.put(state);
        this.launch(workspace);
        return { state, resumed: !!resumable, alreadyRunning: false };
    }

    /** Re-launch every checkpoint left `running` by a previous process. Call once at startup. */
    resumeAll(): void {
        for (const s of this.o.store.list()) {
            if (s.status === 'running' && !this.active.has(s.workspace)) this.launch(s.workspace);
        }
    }

    cancel(workspace: string): boolean {
        const live = this.active.get(workspace);
        if (!live) return false;
        live.ctl.stop = 'cancel';
        return true;
    }

    status(workspace: string): RebuildState | null { return this.o.store.get(workspace); }

    stats(): RebuildStats {
        return { active: this.active.size, busyWaits: this.busyWaits, runs: this.o.store.list() };
    }

    /** Shutdown: stop batching but leave the checkpoint `running` so the next start resumes. */
    seal(): void {
        this.sealed = true;
        for (const a of this.active.values()) if (!a.ctl.stop) a.ctl.stop = 'seal';
    }

    async drain(timeoutMs: number): Promise<{ timedOut: boolean }> {
        this.seal();
        const all = Promise.all([...this.active.values()].map((a) => a.done));
        let t: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), timeoutMs); t.unref?.(); });
        try { return { timedOut: (await Promise.race([all.then(() => 'done' as const), expired])) === 'timeout' }; }
        finally { if (t) clearTimeout(t); }
    }

    /** Test helper: resolves when the workspace's run (if any) has finished. */
    async whenIdle(workspace: string): Promise<void> { await this.active.get(workspace)?.done; }

    private launch(workspace: string): void {
        const ctl: Control = { stop: false };
        const done = this.run(workspace, ctl)
            .catch((err) => this.fail(workspace, err))
            .finally(() => { this.active.delete(workspace); });
        this.active.set(workspace, { ctl, done });
    }

    private fail(workspace: string, err: unknown): void {
        const msg = (err as Error)?.message ?? String(err);
        this.o.onError?.(`link rebuild failed (${workspace}): ${msg}`);
        try {
            const st = this.o.store.get(workspace);
            if (st) this.o.store.put({ ...st, status: 'failed', finishedAt: this.now(), lastError: msg });
        } catch { /* store already closed (shutdown) */ }
    }

    /** Stop and release the checkpoint store. An in-flight batch finishes against a closed store and is dropped. */
    close(): void {
        this.seal();
        try { this.o.store.close(); } catch { /* already closed */ }
    }

    private async run(workspace: string, ctl: Control): Promise<void> {
        const sub = this.o.substrate;
        const handles = await sub.openHandles(workspace);
        if (!handles?.verbatim.listIds) throw new Error('workspace_unavailable');
        const ids = [...new Set((await handles.verbatim.listIds('lore:')).map(nodeIdOfRow).filter((x): x is string => x !== null))].sort();
        const idSet = new Set(ids);
        const st = { ...this.o.store.get(workspace)! };
        let i = 0;
        if (st.cursor !== null) { while (i < ids.length && ids[i]! <= st.cursor) i++; }
        st.total = st.done + (ids.length - i);
        this.o.store.put(st);

        while (i < ids.length && !ctl.stop) {
            await this.waitWhileBusy(ctl);
            if (ctl.stop) break;
            const batch = ids.slice(i, i + this.o.batchSize);
            await this.processBatch(workspace, handles, batch, idSet, st);
            i += batch.length;
            st.cursor = batch[batch.length - 1]!;
            st.done += batch.length;
            this.o.store.put(st);
            if (i < ids.length && this.o.yieldMs > 0) await this.sleep(this.o.yieldMs);
        }
        if (ctl.stop === 'seal') { this.o.store.put({ ...st, status: 'running' }); return; }
        this.o.store.put({ ...st, status: ctl.stop === 'cancel' ? 'cancelled' : 'done', finishedAt: this.now() });
    }

    private async waitWhileBusy(ctl: Control): Promise<void> {
        let waited = 0;
        let counted = false;
        while (!ctl.stop && waited < this.o.maxWaitMs && this.o.isBusy()) {
            if (!counted) { this.busyWaits++; counted = true; }
            await this.sleep(BUSY_POLL_MS);
            waited += BUSY_POLL_MS;
        }
    }

    private async processBatch(workspace: string, handles: LinkHandles, batch: string[], idSet: Set<string>, st: RebuildState): Promise<void> {
        const sub = this.o.substrate;
        const computed = await sub.computeLinks(workspace, batch);
        if (!computed) throw new Error('workspace_unavailable');
        const batchSet = new Set(batch);
        // Each edge is judged by ONE batch: the one holding its owner (its lower endpoint, or the higher one when the lower is not a node).
        const owns = (e: LoreEdge): boolean => {
            const [lo, hi] = sortedPair(e.sourceId, e.targetId);
            return batchSet.has(idSet.has(lo) ? lo : hi);
        };
        const res = await reconcileLinks({ workspace, graph: handles.graph, sub, batch, computed, owns, now: this.now, counters: st });
        if (res.written > 0 || res.invalidated > 0) this.o.onWrote?.(workspace);
    }
}
