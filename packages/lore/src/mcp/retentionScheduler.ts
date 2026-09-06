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
    /** Cancel BOTH timers. Idempotent. */
    stop(): void;
}

/**
 * Every scheduler armed by {@link scheduleRetentionSweep}, so a shutdown can
 * cancel them — see {@link stopAllRetentionSweeps}.
 *
 * The daily timer used to be UNSTOPPABLE BY CONSTRUCTION: it was created
 * inside the bootstrap callback and its handle was never returned, so once the
 * bootstrap had fired (60 s after boot by default) nothing in the process could
 * ever clear it. The drain closes the graph + verbatim handles; a later fire
 * then re-opened them through `getGraphHandle` / `getOrOpen`
 * (mcp/daemonTimers.ts `runRetentionSweepAllWorkspaces`), leaking a graph and a
 * LanceDB handle per workspace — and risking two live handles on one surrealkv
 * directory once the switch had re-opened it. Same defect class as the
 * access-tracker resurrection, and the reason both are now stoppable.
 *
 * Daemon-only in practice (`startsDaemonTimers` gates the arming), so this is
 * not the embedded-host hang; the drain also runs on /api/workspaces/switch and
 * /api/daemon/restart, after which the daemon keeps going, which is where it
 * bites.
 */
const liveSchedulers = new Set<RetentionScheduler>();

/** Cancel every armed retention sweep. Called by the ordered shutdown drain
 *  before substrate handles close. Best-effort and idempotent. */
export function stopAllRetentionSweeps(): void {
    for (const s of [...liveSchedulers]) {
        try { s.stop(); } catch { /* best-effort */ }
    }
    liveSchedulers.clear();
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
    // Held OUTSIDE the callback so stop() can reach it. Previously this handle
    // only ever existed inside the closure below, which made the daily sweep
    // permanently uncancellable — see `liveSchedulers` above.
    let dailyTimer: NodeJS.Timeout | null = null;
    let stopped = false;
    const bootstrapTimer = setTimeout(() => {
        if (stopped) return;   // cancelled between arming and firing
        void runSweep(false).catch((err) => {
            console.error('[retention] daily sweep failed:', (err as Error).message);
        });
        dailyTimer = setInterval(() => {
            void runSweep(false).catch((err) => {
                console.error('[retention] daily sweep failed:', (err as Error).message);
            });
        }, DAILY_INTERVAL_MS);
        if (typeof dailyTimer.unref === 'function') dailyTimer.unref();
    }, FIRST_FIRE_MS);
    if (typeof bootstrapTimer.unref === 'function') bootstrapTimer.unref();
    const scheduler: RetentionScheduler = {
        bootstrapTimer,
        stop(): void {
            stopped = true;
            clearTimeout(bootstrapTimer);
            if (dailyTimer) { clearInterval(dailyTimer); dailyTimer = null; }
            liveSchedulers.delete(scheduler);
        },
    };
    liveSchedulers.add(scheduler);
    return scheduler;
}
