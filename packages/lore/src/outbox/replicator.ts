/**
 * outbox/replicator.ts — background polling replicator service.
 *
 * Sprint O1 (2026-05-24). Reads outbox rows with entry-level
 * status='pending' or 'failed' per workspace, dispatches them to
 * the substrate fan-out function via `dispatch()`, marks rows
 * 'replicated' on success or 'failed' (then 'dead' after N attempts)
 * on error. Per-workspace queues — one slow workspace cannot block
 * another's replication.
 *
 * Crash recovery: on start(), reads `outbox-replication.json` (per
 * workspace lastReplicatedSeq cursor) so we don't re-walk
 * already-replicated rows after a restart. Each successful
 * replication advances the cursor.
 *
 * Loop shape:
 *   while running:
 *     for ws in store.listWorkspacesWithPending():
 *       for entry in store.listPendingForWorkspace(ws, batchSize):
 *         try dispatch(entry); mark replicated; advance cursor
 *         catch: mark failed (or dead after maxAttempts)
 *     sleep(idleMs)
 *
 * Backoff: failed entries are picked up again on the next tick but
 * with `attempts` bumped. Once attempts >= maxAttempts we mark the
 * row 'dead' and skip it on future polls — operator must intervene.
 *
 * SCOPE — O1 ships the loop + lifecycle + per-workspace fan-out.
 * The substrate calls themselves are wired via the `substrates`
 * parameter; the daemon supplies them from its boot wiring. Until
 * a producer actually emits new-shape outbox rows (O2/O3), the loop
 * runs but has nothing to process — confirmed by checking
 * `store.listWorkspacesWithPending()` returns [] for fresh
 * universal-write entries until O2 starts wrapping writes.
 *
 * **Test mode guard**: per the O1 hard constraint, the replicator
 * MUST NOT start in test mode. The `wireReplicator()` factory
 * exposes the service but does not auto-start; the daemon calls
 * `.start()` from main(). Tests construct the service manually
 * and may call `.tickOnce()` deterministically without spinning
 * the background loop.
 */

import type { DispatcherSubstrates } from './dispatcher.js';
import { dispatch, MissingPayloadError, UnwiredOperationKindError, verifyApplied } from './dispatcher.js';
import { collectVerbatimUpsertRun, consolidateVerbatimRun } from './verbatimConsolidation.js';
import { keyOfEntry, type EntityFamily } from './supersession.js';
import type { OutboxLagCache } from './lagCache.js';
import type { OutboxEntry, OutboxStore } from './types.js';
import { DeadLetterWatch } from './deadLetterWatch.js';

/**
 * Sprint E3 — embed.batch consolidation cap (total merged texts.length,
 * NOT row count). The replicator merges adjacent embed.batch rows into one
 * dispatch to save model warm-ups + storeEmbedBatch round-trips. Default
 * 1024 bounds JS-heap memory while exceeding the largest provider chunk cap.
 * Set to 0 to disable. Env: LORE_OUTBOX_CONSOLIDATION_CAP (NW-7c).
 */
function parseEnvInt(raw: string | undefined, fallback: number): number {
    if (!raw || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
export const EMBED_BATCH_CONSOLIDATION_CAP: number = parseEnvInt(process.env.LORE_OUTBOX_CONSOLIDATION_CAP, 1024);

/**
 * SP-13 — max adjacent `verbatim.upsert` rows consolidated into ONE
 * storeBatch dispatch (one LanceDB fragment per run instead of per row).
 * 256 matches the verbatim storeBatch internal BATCH_SIZE. Set to 0 to
 * disable. Env: LORE_REPLICATOR_CONSOLIDATION_MAX (NW-7c).
 */
export const VERBATIM_UPSERT_CONSOLIDATION_CAP: number = parseEnvInt(process.env.LORE_REPLICATOR_CONSOLIDATION_MAX, 256);

export interface ReplicatorConfig {
    /** Max entries fetched per workspace per tick. Default 100. */
    batchSize: number;
    /** Idle sleep when no pending work across all workspaces. Default 250 ms. */
    idleMs: number;
    /** Sleep between non-empty ticks (lets event loop breathe). Default 10 ms. */
    busyMs: number;
    /** Max replication attempts before marking 'dead'. Default 5. */
    maxAttempts: number;
    /**
     * Sprint O6 (2026-05-24) — self-heal tick cadence. The replicator
     * runs a self-heal sweep at most once every `selfHealIntervalMs`
     * milliseconds: it lists `status='failed'` rows whose `failedAt`
     * is older than `selfHealGraceMs` (so we never race in-flight
     * writes) and probes each via the dispatcher's `verifyApplied`
     * hook. If substrate already holds the row's effect the row is
     * flipped to 'replicated'; otherwise it's left for the normal
     * retry path.
     *
     * Default 60_000 ms (1 minute) — slow enough to be free in steady
     * state, fast enough to clear backpressure before an operator
     * notices.
     */
    selfHealIntervalMs: number;
    /** Sprint O6 — minimum age a `status='failed'` row must reach
     *  before self-heal will touch it. Default 5_000 ms (5s). Shields
     *  against the "replicator marked failed but the substrate write
     *  is still in flight on the hot lane" race. Set to 0 in tests to
     *  bypass the gate. */
    selfHealGraceMs: number;
    /** Sprint O6 — max rows per self-heal sweep. Bounds the substrate
     *  probe burst when a sudden batch of failures lands. Default 256. */
    selfHealBatchSize: number;
    /**
     * SP-F2 (2026-06-10) — retention for 'replicated' rows. Before this
     * fix nothing ever deleted them, so outbox.sqlite grew linearly with
     * every write for the daemon's lifetime (two full-payload rows per
     * node write via postNode). The replicator now prunes
     * status='replicated' rows whose replicatedAt is older than this
     * many ms, on the self-heal cadence (selfHealIntervalMs). 'failed'
     * and 'dead' rows are NEVER pruned — operator-triage state. Set 0
     * to disable. Default 7 days: long enough for audit/debug archaeology,
     * short enough to bound the file.
     */
    pruneReplicatedOlderThanMs: number;
}

export const DEFAULT_REPLICATOR_CONFIG: ReplicatorConfig = {
    batchSize: 100,
    idleMs: 250,
    busyMs: 10,
    maxAttempts: 5,
    selfHealIntervalMs: 60_000,
    selfHealGraceMs: 5_000,
    selfHealBatchSize: 256,
    pruneReplicatedOlderThanMs: 7 * 24 * 60 * 60 * 1000,
};

/**
 * hc-replicator-polling-hardcoded (NW-7c) — read env overrides for the
 * polling intervals so operators can dial the loop cadence without a code
 * change. Two knobs:
 *
 *   LORE_OUTBOX_POLL_MS   idle-sleep when no pending work   default 250
 *   LORE_OUTBOX_BUSY_MS   sleep between non-empty ticks     default 10
 *
 * Invalid values fall back to defaults silently.
 */
export function readEnvPollConfig(): Pick<ReplicatorConfig, 'idleMs' | 'busyMs'> {
    return {
        idleMs: parseEnvInt(process.env.LORE_OUTBOX_POLL_MS, DEFAULT_REPLICATOR_CONFIG.idleMs),
        busyMs: parseEnvInt(process.env.LORE_OUTBOX_BUSY_MS, DEFAULT_REPLICATOR_CONFIG.busyMs),
    };
}

/** SP-F2 — max replicated rows deleted per prune sweep. Bounds the
 *  SQLite delete-transaction size after a long-running daemon's first
 *  sweep over a multi-month backlog. */
export const PRUNE_SWEEP_BATCH_LIMIT = 5_000;

/**
 * Sprint O6 — read env overrides for the self-heal cadence so an
 * operator can dial up/down without a code change. Three knobs:
 *
 *   LORE_OUTBOX_SELFHEAL_INTERVAL_MS  default 60000
 *   LORE_OUTBOX_SELFHEAL_GRACE_MS     default 5000
 *   LORE_OUTBOX_SELFHEAL_BATCH        default 256
 *
 * SP-F2 adds a fourth knob for the replicated-row retention sweep:
 *
 *   LORE_OUTBOX_PRUNE_REPLICATED_MS   default 604800000 (7 days; 0 disables)
 *
 * Invalid values fall back to defaults silently — never throws on the
 * daemon-boot path.
 */
export function readEnvSelfHealConfig(): Pick<ReplicatorConfig, 'selfHealIntervalMs' | 'selfHealGraceMs' | 'selfHealBatchSize' | 'pruneReplicatedOlderThanMs'> {
    const parse = (raw: string | undefined, fallback: number, minimum = 0): number => {
        if (!raw) return fallback;
        const n = Number(raw);
        return Number.isFinite(n) && n >= minimum ? n : fallback;
    };
    return {
        selfHealIntervalMs: parse(process.env.LORE_OUTBOX_SELFHEAL_INTERVAL_MS, DEFAULT_REPLICATOR_CONFIG.selfHealIntervalMs),
        selfHealGraceMs: parse(process.env.LORE_OUTBOX_SELFHEAL_GRACE_MS, DEFAULT_REPLICATOR_CONFIG.selfHealGraceMs),
        selfHealBatchSize: parse(process.env.LORE_OUTBOX_SELFHEAL_BATCH, DEFAULT_REPLICATOR_CONFIG.selfHealBatchSize, 1),
        pruneReplicatedOlderThanMs: parse(process.env.LORE_OUTBOX_PRUNE_REPLICATED_MS, DEFAULT_REPLICATOR_CONFIG.pruneReplicatedOlderThanMs),
    };
}

export interface ReplicatorWiring {
    store: OutboxStore;
    substrates: DispatcherSubstrates;
    config?: Partial<ReplicatorConfig>;
    /** Optional logger; defaults to console.error. */
    log?: (msg: string) => void;
    /** Sprint O4 — lag cache the replicator refreshes once per tick.
     *  Routes read it synchronously on the hot path to decide whether
     *  to return 503 outbox_lag. Optional: when undefined the
     *  replicator skips the refresh and routes that consult an unwired
     *  cache fail-open (no backpressure). */
    lagCache?: OutboxLagCache;
}

export interface ReplicatorStats {
    /** Total entries successfully replicated since start. */
    replicated: number;
    /** Total failures (per-attempt; an entry that fails 3 times then
     *  succeeds counts as 3 here + 1 in `replicated`). */
    failures: number;
    /** Total entries marked 'dead' since start. */
    dead: number;
    /** Total ticks executed. */
    ticks: number;
    /** Wallclock ms of the last tick. */
    lastTickMs: number;
    /** Sprint O6 — total rows flipped 'failed' → 'replicated' by the
     *  self-heal tick since start. Surfaces in operator logs so a
     *  spike (suggesting a replicator/substrate inconsistency) is
     *  visible. */
    selfHealed: number;
    /** Sprint O6 — total self-heal sweeps executed. Lets operators
     *  cross-check the configured cadence against actual cadence in
     *  case the loop is stalled. */
    selfHealSweeps: number;
    /** Sprint O6 — total candidates examined across all sweeps. */
    selfHealExamined: number;
    /** SP-F2 — total 'replicated' rows deleted by the retention sweep
     *  since start. Surfaces in operator logs / health output. */
    pruned: number;
}

export class OutboxReplicator {
    private readonly store: OutboxStore;
    private readonly substrates: DispatcherSubstrates;
    private readonly cfg: ReplicatorConfig;
    private readonly log: (msg: string) => void;
    private readonly lagCache?: OutboxLagCache;
    private running = false;
    private loopPromise: Promise<void> | null = null;
    private readonly stats: ReplicatorStats = {
        replicated: 0, failures: 0, dead: 0, ticks: 0, lastTickMs: 0,
        selfHealed: 0, selfHealSweeps: 0, selfHealExamined: 0, pruned: 0,
    };
    private lastSelfHealAt = 0;
    private lastPruneAt = 0;

    constructor(wiring: ReplicatorWiring) {
        this.store = wiring.store;
        this.substrates = wiring.substrates;
        this.cfg = { ...DEFAULT_REPLICATOR_CONFIG, ...(wiring.config ?? {}) };
        this.log = wiring.log ?? ((m: string) => console.error(m));
        this.lagCache = wiring.lagCache;
    }

    /** Idempotent. No-op if already running. */
    start(): void {
        if (this.running) return;
        if (!this.requiredStoreMethods()) {
            this.log('[outbox replicator] store missing universal-write methods; not starting');
            return;
        }
        this.running = true;
        this.loopPromise = this.loop().catch((err) => {
            this.log(`[outbox replicator] loop crashed: ${(err as Error).message}`);
        });
        this.log('[outbox replicator] started');
    }

    /** Idempotent. Awaits the loop to drain. */
    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        if (this.loopPromise) {
            await this.loopPromise;
            this.loopPromise = null;
        }
        this.log('[outbox replicator] stopped');
    }

    /** Snapshot of replicator-side counters. Read by /api/health
     *  alongside the store-side depth/lag stats. */
    getStats(): Readonly<ReplicatorStats> {
        return this.stats;
    }

    /**
     * Run exactly one tick. Used by tests for deterministic
     * single-step exercise. Returns the number of entries processed.
     */
    async tickOnce(): Promise<number> {
        if (!this.requiredStoreMethods()) return 0;
        const n = await this.runTick();
        await this.maybeSelfHeal();
        await this.maybePruneReplicated();
        await this.refreshLagCache();
        return n;
    }

    /**
     * SP-F2 (2026-06-10) — replicated-row retention sweep.
     *
     * Deletes status='replicated' rows older than
     * `pruneReplicatedOlderThanMs` (default 7 days) via the store's
     * optional `pruneReplicated` hook. Bounded to
     * PRUNE_SWEEP_BATCH_LIMIT rows per sweep; a long backlog drains
     * over successive sweeps. 'failed' and 'dead' rows are never
     * touched, and `outbox_replication_state` is preserved so
     * sequenceIds stay monotonic after pruning.
     *
     * `force=true` bypasses the cadence gate (CLI / tests).
     * `olderThanMsOverride` bypasses the configured retention window
     * (tests prune everything with 0). Returns rows deleted.
     */
    async runPruneSweep(opts?: { force?: boolean; olderThanMsOverride?: number; limit?: number }): Promise<number> {
        const fn = this.store.pruneReplicated?.bind(this.store);
        if (typeof fn !== 'function') return 0;
        const olderThanMs = opts?.olderThanMsOverride ?? this.cfg.pruneReplicatedOlderThanMs;
        if (opts?.olderThanMsOverride === undefined && this.cfg.pruneReplicatedOlderThanMs <= 0) {
            return 0; // retention disabled by config/env
        }
        if (opts?.force) {
            this.lastPruneAt = Date.now();
        } else {
            const now = Date.now();
            if (now - this.lastPruneAt < this.cfg.selfHealIntervalMs) return 0;
            this.lastPruneAt = now;
        }
        try {
            const n = await fn(Math.max(0, olderThanMs), { limit: opts?.limit ?? PRUNE_SWEEP_BATCH_LIMIT });
            if (n > 0) {
                this.stats.pruned += n;
                this.log(`[outbox replicator] pruned ${n} replicated outbox row(s) older than ${olderThanMs}ms`);
            }
            return n;
        } catch (err) {
            this.log(`[outbox replicator] prune sweep threw: ${(err as Error).message}`);
            return 0;
        }
    }

    /** Internal: cadence-gated prune (piggybacks on the self-heal
     *  interval so steady state costs one cheap indexed DELETE per
     *  selfHealIntervalMs). */
    private async maybePruneReplicated(): Promise<void> {
        await this.runPruneSweep({ force: false });
    }

    /**
     * Sprint O6 (2026-05-24) — explicit self-heal sweep.
     *
     * Used by the operator drain-failed CLI AND by tests that want
     * deterministic single-shot self-heal regardless of the cadence
     * gate. Returns a per-workspace + per-operationKind report so the
     * caller (CLI or test assertion) can render counts without
     * touching internals.
     *
     * `force=true` ignores `selfHealIntervalMs` (so back-to-back calls
     * still run). `graceMsOverride` ignores `selfHealGraceMs` (lets
     * tests bypass the in-flight-race shield). `dryRun=true` runs the
     * verifier probes but skips the markEntryStatus mutation; useful
     * for the drain-failed --dry-run path.
     */
    async runSelfHealSweep(opts?: {
        force?: boolean;
        graceMsOverride?: number;
        dryRun?: boolean;
        workspace?: string | null;
        limit?: number;
        /**
         * Include status='dead' rows in the sweep. OPERATOR-ONLY (the
         * drain-failed CLI passes this); the routine per-tick self-heal
         * must NOT resurrect dead-letter rows — audit cluster 5
         * (2026-08-17): it used to, silently emptying the dead queue.
         */
        includeDead?: boolean;
    }): Promise<SelfHealReport> {
        const force = opts?.force ?? false;
        const dryRun = opts?.dryRun ?? false;
        const grace = opts?.graceMsOverride ?? this.cfg.selfHealGraceMs;
        const workspace = opts?.workspace ?? null;
        const limit = opts?.limit ?? this.cfg.selfHealBatchSize;
        const report: SelfHealReport = {
            examined: 0, recovered: 0, leftFailed: 0,
            byWorkspace: {}, byOperationKind: {}, dryRun,
            details: [],
        };
        const listFn = this.store.listFailedOlderThan?.bind(this.store);
        if (typeof listFn !== 'function') return report;
        if (!force) {
            const now = Date.now();
            if (now - this.lastSelfHealAt < this.cfg.selfHealIntervalMs) return report;
            this.lastSelfHealAt = now;
        } else {
            this.lastSelfHealAt = Date.now();
        }
        let candidates: OutboxEntry[];
        try {
            candidates = await listFn(grace, { workspace, limit, includeDead: opts?.includeDead === true });
        } catch (err) {
            this.log(`[outbox replicator] self-heal list threw: ${(err as Error).message}`);
            return report;
        }
        report.examined = candidates.length;
        this.stats.selfHealSweeps++;
        this.stats.selfHealExamined += candidates.length;
        for (const entry of candidates) {
            const ws = entry.workspace ?? 'unknown';
            const kind = entry.operationKind ?? 'unknown';
            const outcome = await verifyApplied(entry, this.substrates);
            const detail = { id: entry.id, workspace: ws, operationKind: kind, verified: outcome.verified, reason: outcome.reason };
            report.details.push(detail);
            if (outcome.verified) {
                if (!dryRun) {
                    try {
                        await this.store.markEntryStatus!(entry.id, 'replicated');
                        this.stats.selfHealed++;
                        this.log(`[outbox replicator] self-heal recovered ${entry.id} (${kind}, ws=${ws}, reason=${outcome.reason})`);
                    } catch (err) {
                        this.log(`[outbox replicator] self-heal mark failed for ${entry.id}: ${(err as Error).message}`);
                        report.leftFailed++;
                        continue;
                    }
                }
                report.recovered++;
                bumpReportBucket(report.byWorkspace, ws, 'recovered');
                bumpReportBucket(report.byOperationKind, kind, 'recovered');
            } else {
                report.leftFailed++;
                bumpReportBucket(report.byWorkspace, ws, 'leftFailed');
                bumpReportBucket(report.byOperationKind, kind, 'leftFailed');
            }
        }
        return report;
    }

    /** Internal: invoked at end of each tick. Respects cadence gate. */
    private async maybeSelfHeal(): Promise<void> {
        const now = Date.now();
        if (now - this.lastSelfHealAt < this.cfg.selfHealIntervalMs) return;
        try {
            await this.runSelfHealSweep({ force: false });
        } catch (err) {
            this.log(`[outbox replicator] self-heal sweep threw: ${(err as Error).message}`);
        }
    }

    /** Dead-letter watchdog state — see outbox/deadLetterWatch.ts. */
    private deadLetterWatch = new DeadLetterWatch();

    /** Sprint O4 — refresh the lag cache from the store's
     *  aggregateStats(). Called at the end of each tick AND once
     *  before the loop starts so cold-boot writes don't all hit the
     *  fail-open path. Errors are non-fatal — stale cache is better
     *  than blocking writes. */
    private async refreshLagCache(): Promise<void> {
        // deadLetterWatch rides this same stats read, so it runs even with no
        // lagCache wired (see outbox/deadLetterWatch.ts for why it must).
        const fn = (this.store as { aggregateStats?: () => Promise<import('./types.js').OutboxAggregateStats> }).aggregateStats;
        if (typeof fn !== 'function') return;
        try {
            const stats = await fn.call(this.store);
            this.lagCache?.refresh(stats);
            this.deadLetterWatch.observe(stats.dead, this.log);
        } catch (err) {
            this.log(`[outbox replicator] lag-cache refresh failed: ${(err as Error).message}`);
        }
    }

    private requiredStoreMethods(): boolean {
        return typeof this.store.listWorkspacesWithPending === 'function'
            && typeof this.store.listPendingForWorkspace === 'function'
            && typeof this.store.markEntryStatus === 'function'
            && typeof this.store.readReplicationState === 'function'
            && typeof this.store.writeReplicationState === 'function';
    }

    private async loop(): Promise<void> {
        // Prime the cache once so cold-boot writes see real numbers
        // rather than the fail-open path.
        await this.refreshLagCache();
        while (this.running) {
            const started = Date.now();
            let processed = 0;
            try {
                processed = await this.runTick();
            } catch (err) {
                this.log(`[outbox replicator] tick error: ${(err as Error).message}`);
            }
            // Sprint O6 — self-heal sweep gated by selfHealIntervalMs.
            // Runs after the main fan-out so the cadence is "1 sweep
            // per N seconds of wall clock" rather than "1 sweep per N
            // ticks" (idle ticks tick fast, busy ticks tick slow —
            // tying to wall clock keeps cadence predictable).
            await this.maybeSelfHeal();
            // SP-F2 — replicated-row retention, same wall-clock cadence.
            await this.maybePruneReplicated();
            // Sprint O4 — refresh after every tick (busy or idle) so
            // backpressure clears as soon as the substrate catches up.
            await this.refreshLagCache();
            this.stats.ticks++;
            this.stats.lastTickMs = Date.now() - started;
            const napMs = processed === 0 ? this.cfg.idleMs : this.cfg.busyMs;
            await sleep(napMs);
        }
    }

    private async runTick(): Promise<number> {
        // Snapshot of workspaces with work — safe because each
        // per-workspace pass below re-queries listPendingForWorkspace.
        const workspaces = await this.store.listWorkspacesWithPending!();
        if (workspaces.length === 0) return 0;
        let processed = 0;
        for (const ws of workspaces) {
            // Per-workspace fan-out: process the workspace's batch
            // sequentially, then move to the next workspace. A slow
            // single workspace doesn't block other workspaces because
            // they each get their own batch on the next tick.
            const batch = await this.store.listPendingForWorkspace!(ws, this.cfg.batchSize);
            if (batch.length === 0) continue;
            const cursor = await this.store.readReplicationState!(ws);
            let advanced = cursor.lastReplicatedSeq;
            // SP-F2 — no cursor PRE-FILTER: it once starved a 'failed' row
            // sitting behind a later row's success (cursor advanced past it,
            // filter excluded it forever, attempts froze below maxAttempts).
            // Status is the only row filter (listPendingForWorkspace returns
            // 'pending' + 'failed'). The cursor stays a monotonic watermark
            // for observability + the post-prune sequenceId high-water mark.
            const fresh = batch;
            // Sprint E3 — walk the workspace's slice with a tiny state
            // machine that consolidates adjacent embed.batch entries
            // into a single dispatch. Non-embed entries pass through
            // one-at-a-time (preserves Sprint O ordering for node /
            // edge writes and avoids cross-kind interleaving).
            let i = 0;
            while (i < fresh.length) {
                const entry = fresh[i];
                if (entry.operationKind === 'embed.batch' && EMBED_BATCH_CONSOLIDATION_CAP > 0) {
                    const group = this.collectEmbedBatchRun(fresh, i);
                    if (group.entries.length > 1) {
                        const ok = await this.replicateConsolidatedEmbedBatch(group.entries, group.merged);
                        processed += group.entries.length;
                        if (ok) {
                            const maxSeq = group.entries.reduce(
                                (m, e) => typeof e.sequenceId === 'number' && e.sequenceId > m ? e.sequenceId : m,
                                advanced,
                            );
                            advanced = maxSeq;
                        }
                        i += group.entries.length;
                        continue;
                    }
                    // Fall through to the per-row path when only one
                    // embed.batch row was eligible (no consolidation
                    // win) — keeps the cap-overflow branch simple.
                }
                // SP-13 — consolidate adjacent verbatim.upsert rows into a
                // single storeBatch dispatch (one LanceDB fragment per run
                // instead of per row). Only attempted when the batch hook
                // is wired AND more than one row is eligible; otherwise the
                // per-row path runs unchanged (preserves Sprint O ordering).
                if (entry.operationKind === 'verbatim.upsert'
                    && VERBATIM_UPSERT_CONSOLIDATION_CAP > 0
                    && typeof this.substrates.upsertVerbatimBatch === 'function') {
                    const group = collectVerbatimUpsertRun(fresh, i, VERBATIM_UPSERT_CONSOLIDATION_CAP);
                    if (group.entries.length > 1) {
                        // RA-6 guard: drop superseded-failed rows before the
                        // consolidated dispatch (see consolidateVerbatimRun).
                        const advancedSeq = await consolidateVerbatimRun({
                            store: this.store,
                            substrates: this.substrates,
                            maxAttempts: this.cfg.maxAttempts,
                            onReplicated: () => { this.stats.replicated++; },
                            onFailure: () => { this.stats.failures++; },
                            onDead: () => { this.stats.dead++; },
                            log: (m) => this.log(m),
                            isSupersededFailed: (e) => this.isSupersededFailed(e),
                            dispatchOne: (e) => this.replicateOne(e),
                        }, group);
                        processed += group.entries.length;
                        if (advancedSeq !== null && advancedSeq > advanced) advanced = advancedSeq;
                        i += group.entries.length;
                        continue;
                    }
                    // Single eligible row → per-row path (no win). RA-6 per-key guard now lives in replicateOne (F-S04).
                }
                const ok = await this.replicateOne(entry);
                processed++;
                if (ok && typeof entry.sequenceId === 'number' && entry.sequenceId > advanced) {
                    advanced = entry.sequenceId;
                }
                i++;
            }
            if (advanced > cursor.lastReplicatedSeq) {
                await this.store.writeReplicationState!(ws, {
                    lastReplicatedSeq: advanced,
                    updatedAt: new Date().toISOString(),
                });
            }
        }
        return processed;
    }

    /**
     * Sprint E3 — collect a run of adjacent embed.batch entries
     * starting at index `start` whose merged `texts.length` does not
     * exceed EMBED_BATCH_CONSOLIDATION_CAP. Stops at the first
     * non-embed.batch row, the first row with a malformed payload, or
     * when the next row would push merged.texts over the cap.
     *
     * Returns the consumed entries (always ≥1) plus the merged payload
     * the caller dispatches once.
     */
    private collectEmbedBatchRun(
        batch: readonly OutboxEntry[],
        start: number,
    ): { entries: OutboxEntry[]; merged: { texts: string[]; targetNodeIds: string[] } } {
        const texts: string[] = [];
        const ids: string[] = [];
        const consumed: OutboxEntry[] = [];
        for (let j = start; j < batch.length; j++) {
            const e = batch[j];
            if (e.operationKind !== 'embed.batch') break;
            const payload = (e.payload ?? {}) as { texts?: unknown; targetNodeIds?: unknown };
            if (!Array.isArray(payload.texts) || !Array.isArray(payload.targetNodeIds)) {
                // Malformed payload — let the per-row path mark it dead
                // via MissingPayloadError. Don't roll a bad row into a
                // consolidated batch.
                if (consumed.length === 0) consumed.push(e);
                break;
            }
            // NW-7g (corr-embed-consolidation-misalign): bind text→id as a
            // PAIR before filtering. Filtering the two arrays independently let
            // a single non-string drift them out of alignment, landing every
            // later vector on the WRONG node id. Filter as zipped tuples so a
            // mismatch in either side drops the WHOLE pair.
            const txtArr = payload.texts;
            const idArr = payload.targetNodeIds;
            if (txtArr.length !== idArr.length) {
                if (consumed.length === 0) consumed.push(e);
                break;
            }
            const t: string[] = [];
            const ids2: string[] = [];
            let dropped = false;
            for (let k = 0; k < txtArr.length; k++) {
                const txtVal = txtArr[k];
                const idVal = idArr[k];
                if (typeof txtVal !== 'string' || typeof idVal !== 'string') {
                    dropped = true;
                    continue;
                }
                t.push(txtVal);
                ids2.push(idVal);
            }
            if (dropped && t.length === 0) {
                // Every pair was malformed — treat as a malformed payload.
                if (consumed.length === 0) consumed.push(e);
                break;
            }
            if (consumed.length > 0 && texts.length + t.length > EMBED_BATCH_CONSOLIDATION_CAP) {
                break;
            }
            consumed.push(e);
            for (let k = 0; k < t.length; k++) {
                texts.push(t[k]);
                ids.push(ids2[k]);
            }
            if (texts.length >= EMBED_BATCH_CONSOLIDATION_CAP) break;
        }
        return { entries: consumed, merged: { texts, targetNodeIds: ids } };
    }

    /**
     * Sprint E3 — dispatch a merged embed.batch payload covering N
     * outbox rows. On success every row is marked 'replicated' in one
     * pass. On failure every row gets the failure recorded individually
     * (with bumpAttempt) so per-row retry budget + dead-letter behavior
     * is preserved — a poison consolidated batch eventually flips each
     * contributing row to 'dead' rather than blocking the workspace
     * forever.
     */
    private async replicateConsolidatedEmbedBatch(
        entries: OutboxEntry[],
        merged: { texts: string[]; targetNodeIds: string[] },
    ): Promise<boolean> {
        for (const e of entries) {
            await this.store.markEntryStatus!(e.id, 'replicating');
        }
        const first = entries[0];
        // Synthesize a pseudo-entry that carries the merged payload;
        // the dispatcher's 'embed.batch' branch reads payload.texts +
        // payload.targetNodeIds and is otherwise stateless.
        const synth: OutboxEntry = {
            ...first,
            payload: { texts: merged.texts, targetNodeIds: merged.targetNodeIds },
        };
        try {
            await dispatch(synth, this.substrates);
            for (const e of entries) {
                await this.store.markEntryStatus!(e.id, 'replicated');
                this.stats.replicated++;
            }
            return true;
        } catch (err) {
            const msg = (err as Error).message;
            const isUnwired = err instanceof UnwiredOperationKindError;
            const isInvalid = err instanceof MissingPayloadError;
            for (const e of entries) {
                const attempts = (e.attempts ?? 0) + 1;
                if (isUnwired || isInvalid || attempts >= this.cfg.maxAttempts) {
                    await this.store.markEntryStatus!(e.id, 'dead', { error: msg, bumpAttempt: true });
                    this.stats.dead++;
                    this.log(`[outbox replicator] entry ${e.id} (embed.batch consolidated) marked dead: ${msg}`);
                } else {
                    await this.store.markEntryStatus!(e.id, 'failed', { error: msg, bumpAttempt: true });
                    this.stats.failures++;
                }
            }
            return false;
        }
    }

    private async replicateOne(entry: OutboxEntry): Promise<boolean> {
        // F-S03/S04/S05 (RA-6) + cross-kind generalization (2026-07-05) — a
        // stale 'failed' row can CORRUPT a newer same-entity write when
        // replayed. Skip + mark 'dead' if a newer op on the same ENTITY (any
        // kind in the family) already 'replicated' (see isSupersededFailed).
        if (entry.status === 'failed' && await this.isSupersededFailed(entry)) {
            await this.store.markEntryStatus!(entry.id, 'dead', { error: 'superseded by newer same-key write (RA-6)' });
            this.stats.dead++;
            this.log(`[outbox replicator] entry ${entry.id} (${entry.operationKind}) skipped: superseded by newer same-key write`);
            return false;
        }
        await this.store.markEntryStatus!(entry.id, 'replicating');
        try {
            await dispatch(entry, this.substrates);
            await this.store.markEntryStatus!(entry.id, 'replicated');
            this.stats.replicated++;
            return true;
        } catch (err) {
            const msg = (err as Error).message;
            const attempts = (entry.attempts ?? 0) + 1;
            const isUnwired = err instanceof UnwiredOperationKindError;
            const isInvalid = err instanceof MissingPayloadError;
            // Invalid payloads + unwired kinds will never succeed on
            // retry — mark them dead immediately rather than burning
            // attempts.
            if (isUnwired || isInvalid || attempts >= this.cfg.maxAttempts) {
                await this.store.markEntryStatus!(entry.id, 'dead', { error: msg, bumpAttempt: true });
                this.stats.dead++;
                this.log(`[outbox replicator] entry ${entry.id} (${entry.operationKind}) marked dead: ${msg}`);
                // 2026-06-09 — half-completion reaper. Hot-lane writes
                // verbatim before the durable graph-upsert attempt; if the
                // graph upsert exhausts retries the verbatim row becomes a
                // permanent orphan (vector with no node anywhere). Reap it
                // here. Best-effort: a reap failure must not fail the
                // dead-letter transition itself.
                await this.reapHalfCompletion(entry).catch((reapErr) => {
                    this.log(`[outbox replicator] reap-after-dead failed for ${entry.id} (non-fatal): ${(reapErr as Error).message}`);
                });
            } else {
                await this.store.markEntryStatus!(entry.id, 'failed', { error: msg, bumpAttempt: true });
                this.stats.failures++;
            }
            return false;
        }
    }

    /** F-S03/S04/S05 (RA-6) + cross-kind generalization (2026-07-05) — true
     *  when a strictly-newer REPLICATED op on the SAME entity (same family,
     *  ANY kind) already applied, so replaying this failed row would corrupt
     *  it. keyOfEntry (outbox/supersession.ts) derives the family+identity: a
     *  node.delete supersedes a failed node.upsert on the same id (+ symmetric
     *  node/edge cases); a newer verbatim.upsert supersedes a failed one (own
     *  family, same-kind only). False when no guard/sequenceId/keyless kind. */
    private async isSupersededFailed(entry: OutboxEntry): Promise<boolean> {
        const fn = (this.store as { hasNewerReplicatedForKey?: (ws: string, family: EntityFamily, key: string, seq: number) => Promise<boolean> }).hasNewerReplicatedForKey;
        const identity = keyOfEntry(entry);
        if (typeof fn !== 'function' || typeof entry.sequenceId !== 'number'
            || identity === null || !entry.workspace) {
            return false;
        }
        try {
            return await fn.call(this.store, entry.workspace, identity.family, identity.key, entry.sequenceId);
        } catch (err) {
            this.log(`[outbox replicator] supersede check threw for ${entry.id} (non-fatal): ${(err as Error).message}`);
            return false;
        }
    }

    /**
     * 2026-06-09 — half-completion reaper. Only `node.upsert` enters this
     * loop in a half-completed state (verbatim already persisted via the
     * O2 hot-lane, graph upsert failed terminally). Other operationKinds
     * either own only one substrate (edge.upsert, *.delete) or are
     * idempotent retries (verbatim.upsert, embed.batch) where nothing
     * needs reaping. Returns silently for those kinds.
     */
    private async reapHalfCompletion(entry: OutboxEntry): Promise<void> {
        if (entry.operationKind !== 'node.upsert') return;
        const id = (entry.payload as { id?: unknown })?.id;
        if (typeof id !== 'string' || id.length === 0) return;
        const reap = this.substrates.physicalDeleteVerbatim;
        if (!reap) return;
        // re-audit 2026-06-25 (data loss) — liveness guard. A client can
        // re-upsert the SAME id during the multi-tick retry window before this
        // entry dead-letters; that re-upsert rewrites both the graph node AND
        // the lore:<id> vector (hot-lane verbatim is keyed on node id). If the
        // node is now live, the vector is NOT an orphan — reaping it would
        // silently delete a live node's embedding (vanishes from recall until a
        // re-embed). Only reap when the backing node is provably absent.
        const hasNode = this.substrates.hasNode;
        if (hasNode && await hasNode(id, entry.workspace)) {
            this.log(`[outbox replicator] skip reap of ${id}: node is live in workspace '${entry.workspace ?? '(default)'}' (re-upserted during the retry window)`);
            return;
        }
        // Stored under the `lore:` namespace by the hot-lane writer.
        const vectorId = id.startsWith('lore:') ? id : `lore:${id}`;
        // audit 2026-06-25 (HIGH, cross-workspace data loss) — reap from the
        // ENTRY's workspace, not boot; omitting it let resolveVerbatim() fall
        // back to the boot LanceDB (orphan survives, or a boot-ws vector wiped).
        await reap(vectorId, entry.workspace);
        this.log(`[outbox replicator] reaped half-completed verbatim ${vectorId} from workspace '${entry.workspace ?? '(default)'}' after node.upsert dead-letter`);
    }
}

/** Factory the daemon's outbox/wiring.ts calls during boot. Returns
 *  the constructed-but-not-started service. Caller decides when to
 *  `.start()` so test mode can construct without spinning the loop. */
export function wireReplicator(input: ReplicatorWiring): OutboxReplicator {
    return new OutboxReplicator(input);
}

function sleep(ms: number): Promise<void> { // UNREF'D so an IDLE replicator cannot hold an embedding host's loop open — referenced, it hung any teardown that missed stop(), invisibly (_getActiveHandles reports no timers). Work in flight holds its own handles. See test/embedded-abandoned-dispose-exit-unit.ts
    return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

/**
 * Sprint O6 — self-heal sweep report.
 *
 * Returned by `OutboxReplicator.runSelfHealSweep()`. The drain-failed
 * CLI renders these counts; tests assert against them. Always
 * non-null; an empty sweep returns zero counts rather than undefined.
 */
export interface SelfHealReport {
    examined: number;
    recovered: number;
    leftFailed: number;
    byWorkspace: Record<string, { recovered: number; leftFailed: number }>;
    byOperationKind: Record<string, { recovered: number; leftFailed: number }>;
    dryRun: boolean;
    /** Per-row detail. Bounded by `selfHealBatchSize` so even a
     *  large sweep stays loggable. */
    details: Array<{
        id: string;
        workspace: string;
        operationKind: string;
        verified: boolean;
        reason: string;
    }>;
}

function bumpReportBucket(
    target: Record<string, { recovered: number; leftFailed: number }>,
    key: string,
    field: 'recovered' | 'leftFailed',
): void {
    const bucket = target[key] ??= { recovered: 0, leftFailed: 0 };
    bucket[field]++;
}
