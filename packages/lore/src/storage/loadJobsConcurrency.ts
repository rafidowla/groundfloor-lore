/**
 * storage/loadJobsConcurrency.ts — Sprint Z3 per-workspace concurrency
 * manager + temp-file retention sweeper.
 *
 * Extracted from loadJobsRunner.ts so the runner stays under the
 * 800-line cap and the policy here can be unit-tested in isolation.
 *
 * Sprint Z principle clauses anchored here:
 *   - clause 9 — per-tenant concurrency cap (default 3; 429 on overflow)
 *   - clause 5 — temp-file retention sweeper (no silent loss; failed
 *                jobs retained longer for forensic debugging)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LoadJobsStore } from './loadJobsStore.js';

/** Default per-workspace concurrency cap (Sprint Z principle clause 9). */
export const DEFAULT_MAX_CONCURRENT_PER_WORKSPACE = 3;

/** Default temp-file retention windows. Sprint Z principle clause 5:
 *  retained long enough for clients to re-fetch / triage; failed jobs
 *  retained much longer for forensic debugging. */
export const DEFAULT_RETENTION_HOURS_COMPLETE = 24;
export const DEFAULT_RETENTION_HOURS_FAILED = 24 * 7;

/** Default sweeper tick interval (1h). */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function readPositiveInt(env: string | undefined, fallback: number): number {
    if (!env) return fallback;
    const n = Number.parseInt(env, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
}

/**
 * In-memory per-workspace counter. Authoritative source of truth is
 * load_jobs.status='received'|'running'; the counter is a fast-path
 * cache reconciled on every state transition + at startup.
 */
export class WorkspaceConcurrencyManager {
    private readonly cap: number;
    private readonly counts = new Map<string, number>();

    constructor(cap?: number) {
        this.cap = cap ?? readPositiveInt(
            process.env['LORE_LOAD_MAX_CONCURRENT_PER_WORKSPACE'],
            DEFAULT_MAX_CONCURRENT_PER_WORKSPACE,
        );
    }

    /** Read the per-workspace cap. */
    getCap(): number { return this.cap; }

    /** Current in-flight count for a workspace. */
    getCount(workspace: string): number {
        return this.counts.get(workspace) ?? 0;
    }

    /**
     * Attempt to increment. Returns true if accepted (under cap),
     * false if rejected (at cap — caller emits 429 + Retry-After).
     * Atomicity is fine here: Node single-threaded event loop.
     */
    tryAcquire(workspace: string): boolean {
        const cur = this.counts.get(workspace) ?? 0;
        if (cur >= this.cap) return false;
        this.counts.set(workspace, cur + 1);
        return true;
    }

    /** Unconditional increment — used by reconcile() at startup. */
    forceIncrement(workspace: string, n = 1): void {
        const cur = this.counts.get(workspace) ?? 0;
        this.counts.set(workspace, cur + n);
    }

    /** Decrement on job complete/fail. Never goes below zero. */
    release(workspace: string): void {
        const cur = this.counts.get(workspace) ?? 0;
        const next = Math.max(0, cur - 1);
        if (next === 0) this.counts.delete(workspace);
        else this.counts.set(workspace, next);
    }

    /**
     * Reconcile from the store. Resets internal counts to whatever
     * the persistent store reports as in-flight. Called at daemon
     * startup so a crash mid-batch doesn't strand the counter.
     */
    async reconcile(store: LoadJobsStore): Promise<void> {
        const live = await store.countRunningByWorkspace();
        this.counts.clear();
        for (const [ws, n] of live.entries()) {
            if (n > 0) this.counts.set(ws, n);
        }
    }

    /** Test introspection. */
    snapshot(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const [k, v] of this.counts.entries()) out[k] = v;
        return out;
    }
}

/**
 * Temp-file retention sweeper. Periodically scans load_jobs for
 * complete/failed jobs whose temp_file_path is past the retention
 * window, deletes the file, and NULLs the column.
 *
 * Race protection: rename-then-delete (atomic on POSIX). If a reader
 * still has the renamed file open (rare — only the runner reads
 * temp files and only during 'running'), the OS keeps the inode
 * alive until the reader releases it.
 */
export class TempFileSweeper {
    private readonly store: LoadJobsStore;
    private readonly retentionMsComplete: number;
    private readonly retentionMsFailed: number;
    private readonly intervalMs: number;
    private readonly log: (msg: string) => void;
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(opts: {
        store: LoadJobsStore;
        retentionHoursComplete?: number;
        retentionHoursFailed?: number;
        intervalMs?: number;
        log?: (msg: string) => void;
    }) {
        this.store = opts.store;
        const hoursComplete = opts.retentionHoursComplete ?? readPositiveInt(
            process.env['LORE_LOAD_TEMP_RETENTION_HOURS_COMPLETE'],
            DEFAULT_RETENTION_HOURS_COMPLETE,
        );
        const hoursFailed = opts.retentionHoursFailed ?? readPositiveInt(
            process.env['LORE_LOAD_TEMP_RETENTION_HOURS_FAILED'],
            DEFAULT_RETENTION_HOURS_FAILED,
        );
        this.retentionMsComplete = hoursComplete * 60 * 60 * 1000;
        this.retentionMsFailed = hoursFailed * 60 * 60 * 1000;
        this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
        this.log = opts.log ?? ((m) => console.error(`[loadJobsSweeper] ${m}`));
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        // Schedule the first tick on the interval; do NOT sweep at
        // startup so a fast daemon-restart loop doesn't repeatedly
        // race the runner on its own temp files.
        this.timer = setInterval(() => { void this.tickOnce(); }, this.intervalMs);
        // Prevent the timer from holding the process open during shutdown.
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Single-shot sweep — test entry point + idempotent. Returns the
     *  count of temp files actually deleted. */
    async tickOnce(now: Date = new Date()): Promise<number> {
        const expired = await this.store.listTempRetentionExpired(
            now,
            this.retentionMsComplete,
            this.retentionMsFailed,
        );
        let deleted = 0;
        for (const job of expired) {
            const tmp = job.tempFilePath;
            if (!tmp) continue;
            try {
                if (fs.existsSync(tmp)) {
                    // Rename-then-delete: avoids the unlikely race
                    // where a reader resolves the path between our
                    // existsSync and unlinkSync. The renamed file
                    // is unique-per-job-id so no collisions.
                    const renamed = path.join(
                        path.dirname(tmp),
                        `.sweeping-${job.jobId}-${Date.now()}${path.extname(tmp)}`,
                    );
                    try {
                        fs.renameSync(tmp, renamed);
                        fs.unlinkSync(renamed);
                    } catch (renameErr) {
                        // Best-effort: rename may fail on some FS; fall
                        // back to direct unlink. Either way the row's
                        // temp_file_path is nulled so we don't retry
                        // forever.
                        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
                        this.log(`rename-then-delete fallback for ${job.jobId}: ${(renameErr as Error).message}`);
                    }
                    deleted++;
                }
                await this.store.clearTempFilePath(job.jobId);
                this.log(`sweep deleted temp for job ${job.jobId} (status=${job.status})`);
            } catch (err) {
                this.log(`sweep failed for ${job.jobId}: ${(err as Error).message}`);
            }
        }
        return deleted;
    }
}
