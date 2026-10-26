/**
 * linkService.ts - the link-on-arrival worker (design P0).
 *
 * Writers call `signal(workspace, items)` once a node's vector is COMMITTED.
 * `signal` is synchronous and cheap (one durable queue insert) and never
 * throws: the caller never waits for linking. A single background loop claims
 * batches from the dedicated queue and hands them to the engine-neutral
 * `Linker`.
 *
 *   - Yields to ingestion: waits `quietMs` after the last arrival before it
 *     runs, but never lets the oldest item wait past `maxDelayMs`; an optional
 *     `isBusy` probe (embed queue / outbox backlog) defers it the same way.
 *     Between batches it sleeps `yieldMs`.
 *   - Never touches the outbox, so link backlog cannot trip `outbox_lag`.
 *   - Durable: a restart resumes from the queue file (claimed rows reset).
 *   - Idempotent: the queue is keyed (workspace, node), edge writes are upserts.
 *   - Lifecycle mirrors PendingAutolinkTracker: `seal()` then `drain()` at the
 *     ordered shutdown; queued rows simply stay for the next start.
 */
import type { LinkQueueStore } from './sqliteLinkQueue.js';
import type { LinkRuntimeConfig } from './linkConfig.js';
import { LinkOptOutGate, type LinkGraphResolver } from './linkOptOutGate.js';
import type { LinkEdgeStats, LinkEdgeStatsCapable, LinkItem, Linker } from './linkTypes.js';
import type { LinkPruner, PruneResult } from './linkPruner.js';
import type { LinkRebuilder, RebuildStats } from './linkRebuilder.js';
import type { RebuildState } from './linkRebuildStore.js';
import { acceptProposal, rejectProposal, type AcceptGraph, type DecideOptions, type DecideOutcome } from './discoveryAccept.js';
import type { DiscoveryRunResult, DiscoveryStats, LinkDiscovery } from './discoveryRunner.js';
import type { LinkProposal, ProposalFilter, ProposalStore, TypingLogEntry } from './proposalStore.js';
import type { OutboxStore } from '../outbox/types.js';

export interface LinkStats {
    enabled: true;
    policyVersion: string;
    minSim: number;
    k: number;
    queue: { ready: number; claimed: number; failed: number };
    linkedTotal: number;
    failedTotal: number;
    edgesWrittenTotal: number;
    /** Age of the oldest node whose vector is committed but not yet linked (0 when caught up). */
    lagMs: number;
    /** Recent commit -> linked latency over the last <=256 linked nodes (null before any). */
    recentLagMs: { p50: number; p95: number; samples: number } | null;
    sealed: boolean;
    /** Present when a rebuild (Loop C) is wired: active runs + per-workspace checkpoints. */
    rebuild?: RebuildStats;
    /** Loop B (`refreshOnChange`): off => both counters stay 0 and links are never invalidated by an edit. */
    refreshOnChange: boolean;
    /** Links re-stamped in place / soft-invalidated by refresh-on-change since this process started. */
    refreshedTotal: number;
    invalidatedTotal: number;
    /** The soft per-node cap and the background prune (present when a pruner is wired). */
    prune?: { cap: number; evictedTotal: number; passes: number; dirtyWorkspaces: number; lastPassAt: number | null };
    /** Link-health snapshot across workspaces; null until the first `refreshHealth()` (cached `healthTtlMs`). */
    health: LinkHealth | null;
    /** False when only discovery (Loop D) is on: arrival linking then neither queues nor links. */
    arrival: boolean;
    /** Present when discovery + relation typing (Loop D, `LORE_LINK_DISCOVERY`) is wired. */
    discovery?: DiscoveryStats;
}

/** Aggregate over every workspace the service has seen. Counts cover `link_on_arrival` edges only. */
export interface LinkHealth extends LinkEdgeStats {
    workspaces: number;
    /** Epoch ms the snapshot was taken. */
    at: number;
}

export interface LinkServiceOptions {
    queue: LinkQueueStore;
    linker: Linker;
    config: LinkRuntimeConfig;
    /** True while ingestion is in flight; the worker defers (bounded by maxDelayMs). */
    isBusy?: () => boolean;
    now?: () => number;
    onError?: (message: string) => void;
    /** Rebuild-as-a-diff (Loop C); absent when the Linker cannot support it. */
    rebuilder?: LinkRebuilder;
    /** The workspace's graph (opt-out store); absent => opt-outs cannot be recorded (tests with a fake Linker). */
    resolveGraph?: LinkGraphResolver;
    /** Background soft cap (design P1); absent => no pruning. Only runs when `config.maxLinksPerNode > 0`. */
    pruner?: LinkPruner;
    /** The policy version + model the Linker stamps today; health counts edges stamped otherwise as `stale`. Absent => policy version only. */
    currentStamp?: () => { policyVersion: string; modelFingerprint: string | null };
    /** Loop A switch. Default true; false when the service exists only for discovery (signal() then does nothing). */
    arrival?: boolean;
    /** Loop D: the discovery pass + the proposals it raises. Absent => none of it exists. */
    discovery?: LinkDiscovery;
    discoveryIntervalMs?: number;
    proposals?: ProposalStore;
    /** The host's outbox, when it has one (late-bound: the outbox is built after this service). */
    getOutbox?: () => OutboxStore | null | undefined;
}

const LAG_WINDOW = 256;

export class LinkService {
    private readonly q: LinkQueueStore;
    private readonly linker: Linker;
    private readonly cfg: LinkRuntimeConfig;
    private readonly isBusy: () => boolean;
    private readonly now: () => number;
    private readonly onError: (m: string) => void;
    private readonly rebuilder: LinkRebuilder | null;
    private readonly optOuts: LinkOptOutGate;
    private readonly pruner: LinkPruner | null;
    private readonly resolveGraph: LinkGraphResolver;
    private readonly currentStamp: () => { policyVersion: string; modelFingerprint: string | null };
    private readonly seenWorkspaces = new Set<string>();
    private pruneTimer: ReturnType<typeof setInterval> | null = null;
    private discoveryTimer: ReturnType<typeof setInterval> | null = null;
    private readonly arrival: boolean;
    private readonly discovery: LinkDiscovery | null;
    private readonly discoveryIntervalMs: number;
    private readonly proposals: ProposalStore | null;
    private readonly getOutbox: () => OutboxStore | null | undefined;
    private refreshedTotal = 0;
    private invalidatedTotal = 0;
    private health: LinkHealth | null = null;
    private healthPending: Promise<LinkHealth | null> | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running: Promise<void> | null = null;
    private lastSignalAt = 0;
    private sealedFlag = false;
    private closed = false;
    private edgesTotal = 0;
    private readonly lagSamples: number[] = [];

    constructor(o: LinkServiceOptions) {
        this.q = o.queue;
        this.linker = o.linker;
        this.cfg = o.config;
        this.isBusy = o.isBusy ?? (() => false);
        this.now = o.now ?? Date.now;
        this.onError = o.onError ?? (() => undefined);
        this.rebuilder = o.rebuilder ?? null;
        this.resolveGraph = o.resolveGraph ?? (async () => null);
        this.pruner = o.pruner ?? null;
        this.arrival = o.arrival !== false;
        this.discovery = o.discovery ?? null;
        this.discoveryIntervalMs = o.discoveryIntervalMs ?? 60_000;
        this.proposals = o.proposals ?? null;
        this.getOutbox = o.getOutbox ?? (() => null);
        this.currentStamp = o.currentStamp ?? (() => ({ policyVersion: o.config.policyVersion, modelFingerprint: null }));
        this.optOuts = new LinkOptOutGate({ queue: o.queue, resolveGraph: this.resolveGraph, now: this.now, onError: this.onError });
    }

    /** A vector for each of `items` is now committed. Synchronous, durable, never throws. */
    signal(workspace: string, items: ReadonlyArray<LinkItem>): void {
        if (!this.arrival || this.sealedFlag || this.closed || items.length === 0) return;
        try {
            this.lastSignalAt = this.now();
            this.seenWorkspaces.add(workspace);
            this.q.enqueue(workspace, items, this.lastSignalAt);
            this.schedule();
        } catch (err) {
            this.onError(`link signal failed: ${(err as Error).message}`);
        }
    }

    /**
     * A write's explicit `autolink` choice, recorded BEFORE its vector commits (the commit may happen later, on
     * the embed queue or the outbox). `false` durably opts the nodes out (the Linker skips them as sources and
     * never picks them as neighbours); `true` clears it; `undefined` leaves it. The flag lives in the workspace
     * store (see linkOptOutGate.ts), is NOT consumed by a commit, and has no expiry. Never rejects.
     */
    async setIntent(workspace: string, ids: ReadonlyArray<string>, autolink: boolean | undefined): Promise<void> {
        if (this.closed) return;
        await this.optOuts.setIntent(workspace, ids, autolink);
    }

    /** Resume work left in the queue by a previous process. Call once after construction. */
    start(): void {
        if (this.q.counts().ready > 0) this.schedule();
        // Move any legacy queue-file opt-outs into the workspace stores BEFORE a resumed rebuild reads them.
        void this.optOuts.sweep(() => this.closed).then(() => { if (!this.closed && !this.sealedFlag) this.rebuilder?.resumeAll(); });
        this.startPruneSweep();
        this.startDiscoverySweep();
    }

    /** Loop D: sweep discovery on a timer. Unref'd, cleared by seal/close; a sweep never overlaps itself (the runner single-flights per workspace). */
    private startDiscoverySweep(): void {
        if (!this.discovery || this.discoveryTimer) return;
        this.discoveryTimer = setInterval(() => { void this.discoveryTick(); }, this.discoveryIntervalMs);
        this.discoveryTimer.unref?.();
    }

    private async discoveryTick(): Promise<void> {
        if (!this.discovery || this.sealedFlag || this.closed) return;
        try { await this.discovery.sweep(this.seenWorkspaces); } catch (err) { this.onError(`link discovery sweep failed: ${(err as Error).message}`); }
    }

    /** True when discovery (Loop D) is wired. */
    get hasDiscovery(): boolean { return this.discovery !== null; }

    /** Run discovery on one workspace now (tests, admin tools; resumes from the durable cursor). No-op result when not wired. */
    async runDiscovery(workspace: string): Promise<DiscoveryRunResult | null> {
        if (!this.discovery || this.closed) return null;
        this.seenWorkspaces.add(workspace);
        return this.discovery.run(workspace);
    }

    /** Discovery's per-workspace hook: make sure the durable autolink opt-outs are in place before candidates are scored. */
    ensureOptOutsReady(workspace: string): Promise<void> { return this.optOuts.ensureMigrated(workspace); }

    /** Typing proposals (`supersedes` / `contradicts`) raised by discovery. Pending by default, best score first. */
    listProposals(workspace: string, filter?: ProposalFilter): LinkProposal[] { return this.proposals?.list(workspace, filter) ?? []; }
    /** One proposal by id, scoped to `workspace` (another workspace's id is simply absent). */
    getProposal(workspace: string, id: number): LinkProposal | null { return this.proposals?.get(workspace, id) ?? null; }
    listTypingLog(workspace: string, limit = 100): TypingLogEntry[] { return this.proposals?.listLog(workspace, limit) ?? []; }

    /** Accept a proposal through the existing supersede path (see discoveryAccept.ts). Nothing is applied until this is called. */
    async acceptProposal(workspace: string, id: number, opt?: DecideOptions): Promise<DecideOutcome> {
        if (!this.proposals) return { ok: false, reason: 'not_found' };
        const graph = (await this.resolveGraph(workspace).catch(() => null)) as AcceptGraph | null;
        return acceptProposal({ workspace, graph, proposals: this.proposals, outbox: this.getOutbox() ?? null, now: this.now, onError: this.onError }, id, opt);
    }
    rejectProposal(workspace: string, id: number, opt?: DecideOptions): DecideOutcome {
        if (!this.proposals) return { ok: false, reason: 'not_found' };
        return rejectProposal({ workspace, proposals: this.proposals, now: this.now }, id, opt);
    }

    /** Run the cap prune on a timer while `maxLinksPerNode > 0`. The timer is unref'd and cleared by seal/close. */
    private startPruneSweep(): void {
        if (!this.pruner || this.cfg.maxLinksPerNode <= 0 || this.pruneTimer) return;
        this.pruneTimer = setInterval(() => { void this.pruneTick(); }, this.cfg.pruneIntervalMs);
        this.pruneTimer.unref?.();
    }

    private async pruneTick(): Promise<void> {
        if (!this.pruner || this.sealedFlag || this.closed) return;
        try { await this.pruner.sweep(); } catch (err) { this.onError(`link prune sweep failed: ${(err as Error).message}`); }
    }

    /** Enforce the cap on one workspace now (tests, admin tools). Resolves with what the pass did; no-op without a pruner / cap. */
    async prune(workspace: string): Promise<PruneResult> {
        if (!this.pruner || this.cfg.maxLinksPerNode <= 0 || this.closed) return { evicted: 0, nodesTrimmed: 0, complete: true };
        this.seenWorkspaces.add(workspace);
        return this.pruner.prune(workspace);
    }

    /** True when a rebuild can be started (the engine supports it). */
    get canRebuild(): boolean { return this.rebuilder !== null; }

    /** Start or resume the link rebuild of one workspace (Loop C). Throws `rebuild_unavailable` when not wired. */
    startRebuild(workspace: string): ReturnType<LinkRebuilder['start']> {
        if (!this.rebuilder) return Promise.reject(new Error('rebuild_unavailable'));
        const rb = this.rebuilder;
        this.seenWorkspaces.add(workspace);
        return this.optOuts.ensureMigrated(workspace).then(() => rb.start(workspace));
    }
    cancelRebuild(workspace: string): boolean { return this.rebuilder?.cancel(workspace) ?? false; }
    rebuildStatus(workspace: string): RebuildState | null { return this.rebuilder?.status(workspace) ?? null; }

    seal(): void {
        this.rebuilder?.seal();
        this.sealedFlag = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
        if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
        this.discovery?.stop();
    }
    isSealed(): boolean { return this.sealedFlag; }

    /** Await the in-flight batch (bounded). Queued rows stay durable for the next start. */
    async drain(timeoutMs: number): Promise<{ timedOut: boolean }> {
        this.seal();
        const rb = this.rebuilder ? this.rebuilder.drain(timeoutMs) : Promise.resolve({ timedOut: false });
        void this.pruner?.drain();
        const dr = this.discovery ? this.discovery.drain(timeoutMs) : Promise.resolve({ timedOut: false });
        if (!this.running) { const [a, b] = await Promise.all([rb, dr]); return { timedOut: a.timedOut || b.timedOut }; }
        let t: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), timeoutMs); t.unref?.(); });
        try {
            const out = await Promise.race([this.running.then(() => 'done' as const), expired]);
            return { timedOut: out === 'timeout' || (await rb).timedOut || (await dr).timedOut };
        } finally { if (t) clearTimeout(t); }
    }

    close(): void {
        this.closed = true;
        this.seal();
        this.rebuilder?.close();
        this.pruner?.stop();
        this.proposals?.close();
        this.q.close();
    }

    /** Process everything queued right now, ignoring the quiet period (tests, shutdown tools). */
    async flush(maxBatches = 10_000): Promise<void> {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        for (let i = 0; i < maxBatches; i++) {
            if (this.running) await this.running;
            if (this.q.counts().ready === 0) return;
            await this.runOnce();
        }
    }

    stats(): LinkStats {
        const oldest = this.q.oldestPendingAt();
        const totals = this.q.totals();
        const sorted = [...this.lagSamples].sort((a, b) => a - b);
        const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
        return {
            enabled: true,
            policyVersion: this.cfg.policyVersion,
            minSim: this.cfg.minSim,
            k: this.cfg.k,
            queue: this.q.counts(),
            linkedTotal: totals.linked,
            failedTotal: totals.failed,
            edgesWrittenTotal: this.edgesTotal,
            lagMs: oldest === null ? 0 : Math.max(0, this.now() - oldest),
            recentLagMs: sorted.length ? { p50: at(0.5), p95: at(0.95), samples: sorted.length } : null,
            sealed: this.sealedFlag,
            ...(this.rebuilder ? { rebuild: this.rebuilder.stats() } : {}),
            refreshOnChange: this.cfg.refreshOnChange,
            refreshedTotal: this.refreshedTotal,
            invalidatedTotal: this.invalidatedTotal,
            ...(this.pruner ? { prune: this.pruneStats() } : {}),
            health: this.health,
            arrival: this.arrival,
            ...(this.discovery ? { discovery: this.discovery.stats() } : {}),
        };
    }

    private pruneStats(): NonNullable<LinkStats['prune']> {
        const rows = this.pruner!.states();
        return {
            cap: this.cfg.maxLinksPerNode,
            evictedTotal: rows.reduce((n, r) => n + r.evicted, 0),
            passes: rows.reduce((n, r) => n + r.passes, 0),
            dirtyWorkspaces: rows.filter((r) => r.dirty).length,
            lastPassAt: rows.reduce<number | null>((m, r) => (r.lastPassAt !== null && (m === null || r.lastPassAt > m) ? r.lastPassAt : m), null),
        };
    }

    /**
     * Refresh the link-health snapshot (live / invalidated edge counts, mean strength, max degree, stale stamps,
     * across every workspace this service has seen). Cached for `healthTtlMs` and single-flighted, so a metrics
     * scrape loop costs one aggregate query per workspace per TTL. Never rejects; keeps the last snapshot on error.
     */
    refreshHealth(force = false): Promise<LinkHealth | null> {
        if (this.closed) return Promise.resolve(this.health);
        if (!force && this.health && this.now() - this.health.at < this.cfg.healthTtlMs) return Promise.resolve(this.health);
        if (this.healthPending) return this.healthPending;
        const p = this.computeHealth().catch((err) => { this.onError(`link health failed: ${(err as Error).message}`); return this.health; });
        this.healthPending = p.finally(() => { this.healthPending = null; });
        return this.healthPending;
    }

    private async computeHealth(): Promise<LinkHealth | null> {
        const known = new Set(this.seenWorkspaces);
        for (const s of this.pruner?.states() ?? []) known.add(s.workspace);
        for (const r of this.rebuilder?.stats().runs ?? []) known.add(r.workspace);
        const stamp = this.currentStamp();
        const out: LinkHealth = { workspaces: 0, live: 0, invalidated: 0, meanStrength: null, maxDegree: 0, stale: 0, at: this.now() };
        let weighted = 0;
        for (const ws of [...known].sort()) {
            const g = await this.resolveGraph(ws) as Partial<LinkEdgeStatsCapable> | null;
            if (!g || typeof g.linkEdgeStats !== 'function') continue;
            const s = await g.linkEdgeStats(stamp);
            out.workspaces++; out.live += s.live; out.invalidated += s.invalidated; out.stale += s.stale;
            out.maxDegree = Math.max(out.maxDegree, s.maxDegree);
            if (s.meanStrength !== null) weighted += s.meanStrength * s.live;
        }
        out.meanStrength = out.live > 0 ? weighted / out.live : null;
        this.health = out;
        return out;
    }

    listDuplicates(workspace: string, limit = 100) { return this.q.listDuplicates(workspace, limit); }

    private schedule(): void {
        if (this.timer || this.running || this.sealedFlag || this.closed) return;
        const now = this.now();
        const oldest = this.q.oldestPendingAt() ?? now;
        const quietLeft = this.lastSignalAt + this.cfg.quietMs - now;
        const starveLeft = oldest + this.cfg.maxDelayMs - now;
        let delay = Math.min(Math.max(quietLeft, 0), Math.max(starveLeft, 0));
        if (this.isBusy() && starveLeft > 0) delay = Math.max(delay, Math.min(this.cfg.quietMs, starveLeft));
        this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, Math.max(delay, 0));
        this.timer.unref?.();
    }

    private async tick(): Promise<void> {
        if (this.sealedFlag || this.closed || this.running) return;
        const now = this.now();
        const oldest = this.q.oldestPendingAt();
        const starving = oldest !== null && now - oldest >= this.cfg.maxDelayMs;
        if (!starving && (now - this.lastSignalAt < this.cfg.quietMs || this.isBusy())) { this.schedule(); return; }
        await this.runOnce();
        if (!this.sealedFlag && !this.closed && this.q.counts().ready > 0) {
            this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, this.cfg.yieldMs);
            this.timer.unref?.();
        }
    }

    private runOnce(): Promise<void> {
        if (this.running) return this.running;
        const p = this.processBatch().catch((err) => this.onError(`link batch failed: ${(err as Error).message}`));
        this.running = p.finally(() => { this.running = null; });
        return this.running;
    }

    private async processBatch(): Promise<void> {
        const claim = this.q.claim(this.cfg.batchSize, this.now());
        if (claim.rows.length === 0) return;
        const byWs = new Map<string, typeof claim.rows>();
        for (const r of claim.rows) {
            const list = byWs.get(r.workspace) ?? [];
            list.push(r);
            byWs.set(r.workspace, list);
        }
        for (const [workspace, rows] of byWs) {
            try {
                await this.optOuts.ensureMigrated(workspace); // legacy opt-outs must be in the store before the Linker reads it
                this.seenWorkspaces.add(workspace);
                const items = rows.map((r) => ({ id: r.nodeId, ...(r.ecosystem ? { ecosystem: r.ecosystem } : {}) }));
                // Loop B: with refreshOnChange the batch is reconciled as a diff, so an edit also retires links that no longer qualify.
                const res = this.cfg.refreshOnChange && this.linker.refreshBatch ? await this.linker.refreshBatch(workspace, items) : await this.linker.linkBatch(workspace, items);
                const doneSet = new Set(res.done);
                const doneRows = rows.filter((r) => doneSet.has(r.nodeId));
                this.q.addDuplicates(workspace, res.duplicates, this.now());
                this.q.complete(claim.token, doneRows.map((r) => ({ workspace, nodeId: r.nodeId })));
                const t = this.now();
                for (const r of doneRows) this.recordLag(t - r.committedAt);
                this.edgesTotal += res.edgesWritten;
                this.refreshedTotal += res.refreshed ?? 0;
                this.invalidatedTotal += res.invalidated ?? 0;
                if ((res.wroteEdges ?? res.edgesWritten > 0) && this.cfg.maxLinksPerNode > 0) this.pruner?.markDirty(workspace);
                const retryIds = new Map(res.retry.map((x) => [x.id, x.reason]));
                const unaccounted = rows.filter((r) => !doneSet.has(r.nodeId) && !retryIds.has(r.nodeId));
                this.q.retry(claim.token, [
                    ...res.retry.map((x) => ({ workspace, nodeId: x.id, reason: x.reason })),
                    ...unaccounted.map((r) => ({ workspace, nodeId: r.nodeId, reason: 'unaccounted' })),
                ], this.cfg.maxAttempts);
            } catch (err) {
                this.q.retry(claim.token, rows.map((r) => ({ workspace, nodeId: r.nodeId, reason: (err as Error).message })), this.cfg.maxAttempts);
            }
        }
    }

    private recordLag(ms: number): void {
        this.lagSamples.push(Math.max(0, ms));
        if (this.lagSamples.length > LAG_WINDOW) this.lagSamples.shift();
    }
}
