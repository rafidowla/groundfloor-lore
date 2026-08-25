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
 * ## Config
 *
 * Mirrors `compactionScheduler.ts`'s knobs exactly:
 *   - `LORE_VERSION_RETENTION_DAYS` (default 90) — rows older than this are
 *     pruned, except protected-node rows (pruneVersions already skips those).
 *   - `LORE_VERSION_PRUNE_INTERVAL_MS` (default 24h) — sweep cadence.
 *   - `LORE_VERSION_PRUNE_SCHEDULE_DISABLED=1` — opt-out for operators who
 *     prune on their own cadence.
 *
 * Gating: wired in server.ts under `startsDaemonTimers` — never starts in
 * embedded mode, same as every other sweeper in this file family.
 */

export interface PrunableVersionStore {
    pruneVersions(olderThanDays: number): number;
    hardDeleteCompacted(): number;
    vacuum(): void;
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
    retentionDays?: number;
}

const DEFAULT_RETENTION_DAYS = 90;

function resolveRetentionDays(): number {
    const raw = Number(process.env['LORE_VERSION_RETENTION_DAYS']);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
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
    const days = deps.retentionDays ?? resolveRetentionDays();
    const softCompacted = deps.store.pruneVersions(days);
    const hardDeleted = deps.store.hardDeleteCompacted();
    // VACUUM unconditionally, not just when hardDeleted > 0 — a prior sweep
    // (or a manual prune before this scheduler existed) can leave compacted
    // rows already deleted but the file still fragmented from that delete.
    deps.store.vacuum();
    return { softCompacted, hardDeleted, vacuumed: true };
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
 */
export function scheduleVersionPruneSweep(
    run: () => Promise<VersionPruneSweepResult>,
    intervalMs: number = resolvePruneIntervalMs(),
): VersionPruneScheduler {
    if (scheduleDisabledByEnv()) {
        const inert = setTimeout(() => {}, 0);
        clearTimeout(inert);
        return { timer: inert, async stop(): Promise<void> { /* nothing scheduled */ } };
    }

    let inflight: Promise<VersionPruneSweepResult> | null = null;

    const tick = (): void => {
        const p = run();
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
            if (inflight === p) inflight = null;
        });
    };

    const timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
        timer,
        async stop(): Promise<void> {
            clearInterval(timer);
            if (inflight) await inflight.catch(() => { /* drained, errors already logged */ });
        },
    };
}
