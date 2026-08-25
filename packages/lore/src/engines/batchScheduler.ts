/**
 * batchScheduler.ts — Scheduled batch ingestion (V3.0 Phase A4).
 *
 * Lightweight scheduler that drives connectors on a fixed interval for
 * sources that don't push (no webhook). Each registered job runs its
 * `task` function every `intervalMs`; reentrancy is prevented (a still-
 * running task does not get triggered again until it returns).
 *
 * Why not a real cron library:
 *   - Simple intervals are enough for V3.0-Personal (poll Gmail every
 *     5min, GCal every 15min). Calendar-style cron expressions add
 *     surface area we don't need yet.
 *   - The scheduler can run in-process with no extra dependency.
 *
 * Testability:
 *   - Inject a `clock` (now() and timer.setTimeout/clearTimeout) so
 *     tests can fast-forward without real waits.
 *   - `runOnce(name)` runs a job synchronously regardless of schedule.
 */

export interface ScheduledTaskContext {
    name: string;
    /** Number of times this job has been kicked. */
    runCount: number;
    /** Wall-clock at which this run started (ISO-8601). */
    startedAt: string;
}

export type ScheduledTask = (ctx: ScheduledTaskContext) => Promise<void>;

export interface ScheduledJob {
    name: string;
    intervalMs: number;
    task: ScheduledTask;
    /** Skip the first interval; first run kicks immediately on start(). Default false. */
    runOnStart?: boolean;
}

export interface JobStatus {
    name: string;
    intervalMs: number;
    runCount: number;
    successCount: number;
    errorCount: number;
    lastRunAt?: string;
    lastError?: string;
    isRunning: boolean;
    nextRunAt?: string;
}

export interface SchedulerClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: SchedulerClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface JobState {
    job: ScheduledJob;
    runCount: number;
    successCount: number;
    errorCount: number;
    lastRunAt?: string;
    lastError?: string;
    isRunning: boolean;
    timer?: unknown;
    nextRunAtMs?: number;
}

export class BatchIngestionScheduler {
    private readonly jobs = new Map<string, JobState>();
    private running = false;
    constructor(private readonly clock: SchedulerClock = REAL_CLOCK) { }

    register(job: ScheduledJob): void {
        if (!job.name) throw new Error('scheduler: job.name required');
        if (job.intervalMs <= 0) throw new Error('scheduler: intervalMs must be > 0');
        if (this.jobs.has(job.name)) {
            throw new Error(`scheduler: job '${job.name}' already registered`);
        }
        this.jobs.set(job.name, {
            job,
            runCount: 0, successCount: 0, errorCount: 0,
            isRunning: false,
        });
        if (this.running) this.scheduleNext(job.name);
    }

    unregister(name: string): boolean {
        const state = this.jobs.get(name);
        if (!state) return false;
        if (state.timer !== undefined) this.clock.clearTimeout(state.timer);
        return this.jobs.delete(name);
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        for (const [name, state] of this.jobs) {
            if (state.job.runOnStart) {
                // Kick immediately — fire-and-forget; result lands via state mutation.
                void this.kick(name);
            } else {
                this.scheduleNext(name);
            }
        }
    }

    stop(): void {
        this.running = false;
        for (const state of this.jobs.values()) {
            if (state.timer !== undefined) {
                this.clock.clearTimeout(state.timer);
                state.timer = undefined;
            }
            state.nextRunAtMs = undefined;
        }
    }

    /**
     * Execute a job once, ignoring its schedule. Returns the result of
     * the task call. Useful for tests and admin-app "Run now" buttons.
     */
    async runOnce(name: string): Promise<void> {
        const state = this.jobs.get(name);
        if (!state) throw new Error(`scheduler: unknown job '${name}'`);
        await this.executeOnce(state);
    }

    listStatus(): JobStatus[] {
        return Array.from(this.jobs.values()).map(s => ({
            name: s.job.name,
            intervalMs: s.job.intervalMs,
            runCount: s.runCount,
            successCount: s.successCount,
            errorCount: s.errorCount,
            lastRunAt: s.lastRunAt,
            lastError: s.lastError,
            isRunning: s.isRunning,
            nextRunAt: s.nextRunAtMs ? new Date(s.nextRunAtMs).toISOString() : undefined,
        }));
    }

    /* ---------- internals ---------- */

    private scheduleNext(name: string): void {
        const state = this.jobs.get(name);
        if (!state) return;
        if (!this.running) return;
        const at = this.clock.now() + state.job.intervalMs;
        state.nextRunAtMs = at;
        state.timer = this.clock.setTimeout(() => {
            void this.kick(name);
        }, state.job.intervalMs);
    }

    private async kick(name: string): Promise<void> {
        const state = this.jobs.get(name);
        if (!state) return;
        // Reentrancy guard: skip if the previous run is still going.
        if (state.isRunning) {
            this.scheduleNext(name);
            return;
        }
        await this.executeOnce(state);
        if (this.running) this.scheduleNext(name);
    }

    private async executeOnce(state: JobState): Promise<void> {
        if (state.isRunning) return;
        state.isRunning = true;
        state.runCount++;
        const startedAt = new Date(this.clock.now()).toISOString();
        state.lastRunAt = startedAt;
        try {
            await state.job.task({
                name: state.job.name,
                runCount: state.runCount,
                startedAt,
            });
            state.successCount++;
            state.lastError = undefined;
        } catch (err) {
            state.errorCount++;
            state.lastError = (err as Error).message;
        } finally {
            state.isRunning = false;
        }
    }
}
