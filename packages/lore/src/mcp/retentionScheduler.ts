/**
 * retentionScheduler.ts — Daily retention sweep bootstrap.
 *
 * Extracted from server.ts to keep that file inside the file-size cap.
 *
 * Schedules:
 *   - First sweep 1 minute after boot (so daemon startup isn't blocked).
 *   - Repeats every 24h after the first one fires.
 *   - Both timers unref'd so a clean shutdown isn't held open.
 *
 * Idempotent — running it twice in the same day on the same eligible
 * nodes is safe because tombstone is idempotent (re-tombstoning is a
 * no-op write).
 */

/**
 * TW-7e (hc-retention-sweep-schedule) — env-overridable retention-sweep
 * timing. Defaults preserve the prior behavior (first sweep 1 min after boot,
 * then every 24 h); positive-integer env overrides let an operator tune the
 * cadence without a recompile. Invalid/absent values fall back to the default.
 */
function resolveSchedMs(raw: string | undefined, fallback: number): number {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
const FIRST_FIRE_MS = resolveSchedMs(process.env['LORE_RETENTION_FIRST_FIRE_MS'], 60 * 1000);
const DAILY_INTERVAL_MS = resolveSchedMs(process.env['LORE_RETENTION_INTERVAL_MS'], 24 * 60 * 60 * 1000);

export interface RetentionScheduler {
    bootstrapTimer: NodeJS.Timeout;
}

/**
 * Schedule the daily retention sweep. Returns the bootstrap timer
 * handle for callers that want to cancel scheduling at shutdown.
 *
 * `runSweep(dryRun)` is invoked with `dryRun=false` on every fire;
 * failures are logged and never thrown — the retention loop must not
 * crash the daemon.
 */
export function scheduleRetentionSweep(
    runSweep: (dryRun: boolean) => Promise<unknown>,
): RetentionScheduler {
    const bootstrapTimer = setTimeout(() => {
        void runSweep(false).catch((err) => {
            console.error('[retention] daily sweep failed:', (err as Error).message);
        });
        const dailyTimer = setInterval(() => {
            void runSweep(false).catch((err) => {
                console.error('[retention] daily sweep failed:', (err as Error).message);
            });
        }, DAILY_INTERVAL_MS);
        if (typeof dailyTimer.unref === 'function') dailyTimer.unref();
    }, FIRST_FIRE_MS);
    if (typeof bootstrapTimer.unref === 'function') bootstrapTimer.unref();
    return { bootstrapTimer };
}
