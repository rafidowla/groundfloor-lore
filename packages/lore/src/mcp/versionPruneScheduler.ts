/**
 * versionPruneScheduler.ts — scheduled version-history pruning (LOCAL/daemon
 * mode only).
 *
 * ## Problem
 *
 * `VersionStore.pruneVersions()` (outbox/versionStore.ts) has existed since
 * Feature 8 (2026-05-26) with a documented retention policy in its own
 * header comment — but nothing in the codebase ever called it. `versions.sqlite`
 * records one immutable row per write on any node, with no ceiling, so a
 * long-running local daemon's version history grows forever. Found in the
 * wild: one workspace's `versions.sqlite` reached 896 MB against a healthy
 * sibling's ~130 MB for a comparable node count.
 *
 * Soft-delete alone (the pre-existing `pruneVersions`) would not have fixed
 * this even if it had been wired up: it only sets `compacted=1`, and SQLite
 * does not shrink a file on DELETE without a VACUUM. This scheduler runs all
 * three steps: soft-compact old rows, hard-delete anything already
 * compacted (nothing reads a compacted row — see `hardDeleteCompacted`'s
 * doc comment), then VACUUM to actually reclaim the freed pages on disk.
 *
 * ## Scope — boot-bound, not per-workspace
 *
 * `VersionStore` is opened ONCE at daemon boot, bound to the boot/active
 * workspace's directory (`server.ts` — "CLOUD MUST-FIX: boot-bound = shared
 * across workspaces"). Unlike `compactionSweeper`/`consistencySweeper`/
 * `retentionScheduler`, which all fan out across every registered workspace
 * via `LocalGraphRegistry`, this sweep only prunes the ONE boot-bound store,
 * matching how `VersionStore` is actually used everywhere else today.
 *
 * A full per-workspace fan-out (matching the RC-round4 pattern in
 * daemonTimers.ts) is the correct eventual shape, but doing it here would
 * mean adding a `versionStoreFor()` resolver to `LocalGraphRegistry`, which
 * is already at its file-size cap — a bigger change than the bug in front
 * of us. Flagging as a named follow-up rather than silently expanding scope
 * or silently leaving non-active workspaces unpruned forever.
 *
 * ## Config — OPT-IN (owner decision 2026-09-29)
 *
 * Age-based deletion of version history is OFF by default: no sweep is
 * scheduled and no row is deleted unless pruning is explicitly enabled
 * (see `outbox/versionPruningPolicy.ts` for the resolution rules). This
 * supersedes the earlier 90-day default-on behaviour. Knobs:
 *   - `LORE_VERSION_PRUNE_ENABLED=1` — enable pruning at the 7-year default.
 *   - `LORE_VERSION_RETENTION_DAYS` — retention window when enabled; set
 *     explicitly (without PRUNE_ENABLED) it also enables pruning at that value
 *     (back-compat, logged once). Protected-node rows are never pruned.
 *   - `LORE_VERSION_PRUNE_INTERVAL_MS` (default 24h) — sweep cadence.
 *   - `LORE_VERSION_PRUNE_SCHEDULE_DISABLED=1` — opt-out for operators who
 *     prune on their own cadence.
 *
 * Gating: wired in server.ts under `startsDaemonTimers` — never starts in
 * embedded mode, same as every other sweeper in this file family.
 *
 * ## Storage-growth fix 2/3 (R3) — the embedded-host counterpart
 *
 * `startsDaemonTimers` is false for every `createLore()` library consumer
 * (Atlas, MIRA, PM Helper), so none of them ever ran the sweep above —
 * `versions.sqlite` grew unbounded for exactly the reason this file's header
 * already describes, just on hosts that never own the process. Duplicating
 * `runVersionPruneSweep` for that path would drift the two over time, so
 * `runEmbeddedVersionPruneSweep` below reuses the SAME `pruneVersions` /
 * `hardDeleteCompacted` calls and only swaps the reclaim step: a full
 * `VACUUM` blocks the embedded host's entire event loop for as long as it
 * takes to rewrite the whole file (seconds, on a multi-GB store) — never
 * acceptable on a path a host's own `createLore()` call or writes go
 * through. `VersionStore.incrementalVacuum()` (outbox/versionStore.ts) is
 * the bounded, non-blocking substitute; see that method's doc comment for
 * why it is a no-op on any file that predates this change (only newly
 * created files get `auto_vacuum=INCREMENTAL` — an existing file needs
 * Sprint 3's offline one-time full VACUUM before incremental reclaim can do
 * anything on it).
 */

import { resolveEffectiveVersionHistoryPolicy, type EffectiveVersionHistoryPolicy } from '../outbox/versionPruningPolicy.js';

export interface PrunableVersionStore {
    pruneVersions(olderThanDays: number): number;
    hardDeleteCompacted(): number;
    vacuum(): void;
}

/** Minimal abort-signal shape — deliberately not the DOM `AbortSignal` (no
 *  event emitter, no reason, nothing async) since all that's needed is a
 *  flag a batched loop polls between batches. `scheduleVersionPruneSweep`'s
 *  `stop()` flips it so an in-flight embedded sweep can wind down between
 *  batches instead of running a VACUUM or a whole extra type-pass after
 *  `stop()` was already asked for. */
export interface PruneAbortSignal {
    aborted: boolean;
}

/** `PrunableVersionStore` plus the online-safe reclaim step, plus the async
 *  bounded/yielding prune methods (storage-growth fix 2/3 follow-up,
 *  2026-09-28) — implemented by the same `VersionStore` class; kept as a
 *  separate interface so this module doesn't import the concrete class
 *  (mirrors `PrunableVersionStore` above, which does the same for the daemon
 *  path). Only `runEmbeddedVersionPruneSweep` below uses the batched
 *  methods — the daemon path keeps using the sync ones above unchanged. */
export interface EmbeddedPrunableVersionStore extends PrunableVersionStore {
    incrementalVacuum(maxPages?: number): { ran: boolean; autoVacuumMode: number };
    pruneVersionsBatched(olderThanDays: number, opts?: { batchSize?: number; signal?: PruneAbortSignal }): Promise<number>;
    hardDeleteCompactedBatched(opts?: { batchSize?: number; signal?: PruneAbortSignal }): Promise<number>;
}

export interface VersionPruneSweepResult {
    softCompacted: number;
    hardDeleted: number;
    vacuumed: boolean;
}

export interface VersionPruneSweepDeps {
    /** The boot-bound VersionStore, or null when it failed to open at boot
     *  (server.ts logs a warning and continues without versioning tools in
     *  that case — this sweep must tolerate the same absence). */
    store: PrunableVersionStore | null;
    /** The host's effective policy. Absent = resolved from env (daemon). The
     *  sweep is a no-op unless `policy.enabled`. */
    policy?: EffectiveVersionHistoryPolicy;
    /** May only LENGTHEN the policy's retention window, never shorten it. */
    retentionDays?: number;
}

/**
 * The retention window (days) a sweep would use, or `null` when age-based
 * pruning is not enabled (nothing may be deleted). `maintain`'s dry-run and
 * the sweeps share this so preview and execution can never disagree. An
 * explicit `override` can only lengthen the configured window.
 */
export function resolveRetentionDays(
    policy: EffectiveVersionHistoryPolicy = resolveEffectiveVersionHistoryPolicy(),
    override?: number,
): number | null {
    if (!policy.enabled || policy.retentionDays === null) return null;
    return override !== undefined && Number.isFinite(override) ? Math.max(override, policy.retentionDays) : policy.retentionDays;
}

/**
 * Run one prune pass: soft-compact rows older than the retention window,
 * hard-delete everything already compacted, then VACUUM. Fail-soft — a
 * missing store (boot-time open failure) is a no-op, not a throw, matching
 * how the rest of the versioning surface already tolerates that case.
 */
export async function runVersionPruneSweep(deps: VersionPruneSweepDeps): Promise<VersionPruneSweepResult> {
    if (!deps.store) {
        return { softCompacted: 0, hardDeleted: 0, vacuumed: false };
    }
    const days = resolveRetentionDays(deps.policy, deps.retentionDays);
    if (days === null) return { softCompacted: 0, hardDeleted: 0, vacuumed: false };
    const softCompacted = deps.store.pruneVersions(days);
    const hardDeleted = deps.store.hardDeleteCompacted();
    // VACUUM unconditionally, not just when hardDeleted > 0 — a prior sweep
    // (or a manual prune before this scheduler existed) can leave compacted
    // rows already deleted but the file still fragmented from that delete.
    deps.store.vacuum();
    return { softCompacted, hardDeleted, vacuumed: true };
}

export interface EmbeddedVersionPruneSweepDeps {
    /** The host's own VersionStore, or null when it failed to open (same
     *  fail-soft contract as VersionPruneSweepDeps.store above). */
    store: EmbeddedPrunableVersionStore | null;
    /** Effective policy; resolved from option/env defaults when omitted.
     *  Pruning is a no-op when it is disabled. */
    policy?: EffectiveVersionHistoryPolicy;
    retentionDays?: number;
    /** Bounded page count per `incremental_vacuum` call — see
     *  `VersionStore.incrementalVacuum`'s doc comment. Defaults to that
     *  method's own default (1000). */
    maxVacuumPages?: number;
    /** Rows per batch for the soft-compact/hard-delete passes — see
     *  `VersionStore.DEFAULT_BATCH_SIZE`'s doc comment for the ~2-5k/batch
     *  reasoning. Defaults to that constant. */
    batchSize?: number;
    /** Checked between batches (never mid-statement) so `stop()` can wind an
     *  in-flight sweep down promptly instead of running every remaining
     *  batch plus the vacuum step. */
    signal?: PruneAbortSignal;
}

export interface EmbeddedVersionPruneSweepResult extends VersionPruneSweepResult {
    /** Whether `incrementalVacuum` actually reclaimed pages — false when the
     *  store isn't (yet) `auto_vacuum=INCREMENTAL` (an existing file, before
     *  Sprint 3's offline conversion). `vacuumed` above is kept `true` in
     *  that case too, for shape-compatibility with the daemon path's result
     *  — check `incrementalVacuumRan` to tell the two apart. */
    incrementalVacuumRan: boolean;
}

/**
 * The embedded-host counterpart to `runVersionPruneSweep` — same
 * soft-compact + hard-delete + reclaim shape, but every step is chosen so
 * it never blocks the embedding host's event loop for long:
 *   - soft-compact and hard-delete use the BATCHED, single-pass, yielding
 *     methods (`pruneVersionsBatched`/`hardDeleteCompactedBatched` —
 *     `outbox/versionStore.ts`), not the sync multi-pass ones
 *     `runVersionPruneSweep` uses. Measured on a real 1.36GB/323k-row store
 *     copy, the sync path took ~15-20s of uninterrupted blocking with 5
 *     `skipTypes` configured; the batched path keeps every single
 *     synchronous slice under the stall budget the sprint's stall test
 *     enforces (see version-prune-embedded-stall-unit.ts).
 *   - reclaim uses the bounded, non-blocking `incrementalVacuum()` instead
 *     of a full `VACUUM`.
 * Never call this from a daemon-owned process; that path already has
 * `runVersionPruneSweep` + the daemon's own scheduler, and running both
 * against the same store would double-prune (harmless, since both are
 * idempotent, but wasted work) — server.ts gates the two mutually exclusive
 * on `daemonTimersEnabled()`.
 */
export async function runEmbeddedVersionPruneSweep(
    deps: EmbeddedVersionPruneSweepDeps,
): Promise<EmbeddedVersionPruneSweepResult> {
    if (!deps.store) {
        return { softCompacted: 0, hardDeleted: 0, vacuumed: false, incrementalVacuumRan: false };
    }
    const days = resolveRetentionDays(deps.policy, deps.retentionDays);
    if (days === null) return { softCompacted: 0, hardDeleted: 0, vacuumed: false, incrementalVacuumRan: false };
    const batchOpts = { batchSize: deps.batchSize, signal: deps.signal };
    const softCompacted = await deps.store.pruneVersionsBatched(days, batchOpts);
    const hardDeleted = deps.signal?.aborted ? 0 : await deps.store.hardDeleteCompactedBatched(batchOpts);
    if (deps.signal?.aborted) {
        // Stopped mid-sweep: skip the vacuum step too — it would run against
        // a store whose batches are still only partially applied, and
        // `stop()` is meant to wind down promptly, not squeeze in one more
        // (bounded but non-trivial) PRAGMA call after being asked to quit.
        return { softCompacted, hardDeleted, vacuumed: false, incrementalVacuumRan: false };
    }
    const { ran } = deps.store.incrementalVacuum(deps.maxVacuumPages);
    return { softCompacted, hardDeleted, vacuumed: true, incrementalVacuumRan: ran };
}

export interface VersionPruneScheduler {
    timer: NodeJS.Timeout;
    /** Graceful stop — clears the interval and AWAITS any in-flight pass so
     *  a VACUUM is never killed mid-run by process.exit. Idempotent. */
    stop(): Promise<void>;
}

const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function resolvePruneIntervalMs(): number {
    const raw = Number(process.env['LORE_VERSION_PRUNE_INTERVAL_MS']);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRUNE_INTERVAL_MS;
}

function scheduleDisabledByEnv(): boolean {
    return process.env['LORE_VERSION_PRUNE_SCHEDULE_DISABLED'] === '1';
}

/**
 * Schedule a periodic version-prune pass. Same inert-handle-on-disable shape
 * as `scheduleCompactionSweep` so callers can store/stop it uniformly.
 *
 * `opts.runImmediately` (storage-growth fix 2/3, R3): the daemon path never
 * passed this and keeps its exact pre-Sprint-2 behaviour — first pass after
 * a full `intervalMs` (default 24h). The new embedded-host wiring in
 * server.ts passes `true`, because an embedded host's process may live for
 * far less than 24h between opens, so waiting a full interval for the first
 * pass would mean many embedded hosts never prune at all. The immediate
 * pass runs off a separate, unref'd, zero-delay `setTimeout` — never
 * synchronously inside this function — so it can never block the
 * `createLore()` call that sets this scheduler up.
 *
 * `run` receives a fresh `PruneAbortSignal` for each pass (storage-growth
 * fix 2/3 follow-up, 2026-09-28). The daemon path's `runVersionPruneSweep`
 * ignores the extra argument (its sync multi-pass calls have nowhere to
 * check it mid-run, by design — see that function's doc comment on why it
 * stays a single uninterrupted pass); `runEmbeddedVersionPruneSweep` polls
 * it between batches so `stop()` can interrupt an in-flight embedded sweep
 * instead of only ever stopping the NEXT scheduled one.
 */
export function scheduleVersionPruneSweep(
    run: (signal: PruneAbortSignal) => Promise<VersionPruneSweepResult>,
    intervalMs: number = resolvePruneIntervalMs(),
    opts?: { runImmediately?: boolean },
): VersionPruneScheduler {
    if (scheduleDisabledByEnv()) {
        const inert = setTimeout(() => {}, 0);
        clearTimeout(inert);
        return { timer: inert, async stop(): Promise<void> { /* nothing scheduled */ } };
    }

    let inflight: Promise<VersionPruneSweepResult> | null = null;
    let inflightSignal: PruneAbortSignal | null = null;

    const tick = (): void => {
        const signal: PruneAbortSignal = { aborted: false };
        inflightSignal = signal;
        const p = run(signal);
        inflight = p;
        p.then((result) => {
            if (result.softCompacted > 0 || result.hardDeleted > 0) {
                console.error(
                    `[version-prune] softCompacted=${result.softCompacted} ` +
                    `hardDeleted=${result.hardDeleted} vacuumed=${result.vacuumed}`,
                );
            }
        }).catch((err) => {
            console.error(`[version-prune] pass failed: ${(err as Error).message}`);
        }).finally(() => {
            if (inflight === p) { inflight = null; inflightSignal = null; }
        });
    };

    if (opts?.runImmediately) {
        const kickoff = setTimeout(tick, 0);
        if (typeof kickoff.unref === 'function') kickoff.unref();
    }

    const timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
        timer,
        async stop(): Promise<void> {
            clearInterval(timer);
            if (inflightSignal) inflightSignal.aborted = true;
            if (inflight) await inflight.catch(() => { /* drained, errors already logged */ });
        },
    };
}

/**
 * Storage-growth fix 2/3 (R3) wiring glue — resolves whichever of
 * {daemon, embedded-host} version-prune scheduler is actually live for a
 * given `createLore()` call, extracted out of server.ts to stay under its
 * file-size guardrail (mirrors `outboxOpenPruneSweep.ts`'s R4 extraction).
 *
 * Automatic version-history retention for every `createLore()` host that
 * ISN'T the daemon (Atlas, MIRA, PM Helper, and any other embedded/library
 * consumer). The daemon's own `daemonSweeper` is already inert when
 * `startsDaemonTimers` is false (wireDaemonTimers gates it on the SAME
 * flag), so the two can never double-run against the same store — exactly
 * one of them is ever live.
 *
 * Chosen approach: a timer inside the instance (`scheduleVersionPruneSweep`,
 * reused unmodified from the daemon path — same interval/unref/disable-env
 * handling, only the `run` closure differs), not an on-open one-shot or a
 * new `lore.pruneHistory()` host API. Reasoning:
 *   - An on-open-only prune never revisits a host process that stays up for
 *     a long time (Atlas can run for days) — R3's bug is unbounded GROWTH,
 *     which needs a recurring pass, not a one-time one at boot.
 *   - A new host API (`lore.pruneHistory()`) would put the burden of
 *     remembering to call it on every embedding host, and Atlas/MIRA/PM
 *     Helper are exactly the hosts that showed the growth in the first
 *     place — they already forgot the daemon-only path existed.
 *   - `runImmediately: true` still gives an immediate first pass — a host
 *     process that lives 10 minutes still prunes once, not only after 24h.
 *
 * The returned handle stops on `close()`/`dispose()` via `buildOrderedDrain`
 * in server.ts (same drain the daemon's own sweeper stops through), and is
 * `unref()`'d inside `scheduleVersionPruneSweep` itself, so it can never
 * keep an embedding host's process alive on its own.
 *
 * Narrowed to `{ stop(): Promise<void> }` on both branches — matches
 * daemonTimers.ts's own inert-handle idiom for every other sweeper in that
 * file family rather than fabricating a `timer` field just to satisfy
 * `VersionPruneScheduler`'s full shape; shutdownDrain.ts's
 * `versionPruneSweeper` slot only ever needs `.stop()`.
 */
export function resolveVersionPruneSweeper(
    startsDaemonTimers: boolean,
    daemonSweeper: { stop(): Promise<void> },
    store: EmbeddedPrunableVersionStore | null,
    policy: EffectiveVersionHistoryPolicy = resolveEffectiveVersionHistoryPolicy(),
): { stop(): Promise<void> } {
    if (startsDaemonTimers) {
        return daemonSweeper; // daemon's own sweeper owns this store
    }
    // Opt-in (owner decision 2026-09-29): nothing is scheduled unless the
    // host enabled age-based pruning. Default = keep history forever.
    if (!policy.enabled) return { stop: async () => undefined };
    return scheduleVersionPruneSweep(
        (signal) => runEmbeddedVersionPruneSweep({ store, policy, signal }),
        undefined,
        { runImmediately: true },
    );
}
