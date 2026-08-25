/**
 * syncPoller.ts — Periodic reconcile loop.
 *
 * Per AUTH_AND_SYNC_DESIGN.md (2026-05-10), sync v1 is poll-based.
 * Each tick:
 *   1. ask cloud which workspaces this user is authorized to see
 *   2. diff against on-disk state via `reconcile()`
 *   3. for each `pull` entry: fetch snapshot + hand bytes to applier
 *   4. for each `drop` entry: hand workspace id to remover
 *   5. log a summary line; emit a "tick complete" callback
 *
 * Pure-ish: the poller doesn't touch disk itself. The host passes in
 * three callbacks — `readLocalState`, `applySnapshot`, `removeWorkspace`
 * — so the same poller is used for the real daemon (which writes to
 * `<LORE_HOME>/workspaces/`) and for tests (which use in-memory fakes).
 *
 * Lifecycle:
 *   const poller = new SyncPoller({ ... });
 *   poller.start();    // schedules first tick "soon" + then every intervalMs
 *   poller.stop();     // clears the timer; in-flight tick completes
 *
 * Failure handling — every tick is wrapped:
 *   - cloud unreachable → log + skip
 *   - per-pull failure  → log + leave that workspace's local copy alone
 *   - per-drop failure  → log + retry on next tick
 *   - reconcile throw   → log + bail out of THIS tick (next tick re-tries)
 * Loop never crashes the daemon.
 */

import {
    type CloudSyncClient,
    type SyncedWorkspace,
} from './cloudSyncClient.js';
import {
    reconcile,
    summarizePlan,
    type LocalWorkspaceState,
    type ReconcilePlan,
} from './reconciler.js';

export interface SyncPollerCallbacks {
    /** Read the current on-disk workspace list + their synced versions. */
    readLocalState: () => Promise<LocalWorkspaceState[]>;
    /** Write a pulled snapshot to local disk. Caller writes bytes, updates syncedVersion. */
    applySnapshot: (workspaceId: string, version: string, bytes: Uint8Array) => Promise<void>;
    /** Remove the local workspace dir. Triggered on `drop` actions. */
    removeWorkspace: (workspaceId: string) => Promise<void>;
}

export interface SyncPollerOptions {
    client: CloudSyncClient;
    callbacks: SyncPollerCallbacks;
    /** Tick interval in ms. Default 60s. The user-decided latency target was "minutes via poll is fine for v1." */
    intervalMs?: number;
    /** Delay before the first tick after start(). Default 1s. */
    initialDelayMs?: number;
    /** Set true when cloud is the authoritative workspace list. Mirrors `reconcile`'s safety guard. */
    cloudIsAuthoritative: boolean;
    /** Workspace ids that the reconciler must never drop. Forwarded to `reconcile`. */
    neverDrop?: ReadonlyArray<string>;
    /** Optional hook for observability — called after every tick with the plan + any errors. */
    onTickComplete?: (result: SyncTickResult) => void;
    /** Optional logger override. Defaults to console.log/console.error. */
    log?: { info: (msg: string) => void; error: (msg: string) => void };
}

export interface SyncTickResult {
    skipped?: 'unreachable' | 'reconcile-failed' | 'workspace-list-failed';
    plan?: ReconcilePlan;
    /** Successful pulls (workspaceId → version applied). */
    pullsApplied: Array<{ workspaceId: string; version: string }>;
    /** Pulls that failed (workspaceId → reason). */
    pullsFailed: Array<{ workspaceId: string; reason: string }>;
    /** Successful drops. */
    dropsApplied: string[];
    /** Drops that failed. */
    dropsFailed: Array<{ workspaceId: string; reason: string }>;
    completedAt: string;
}

export class SyncPoller {
    private readonly client: CloudSyncClient;
    private readonly cb: SyncPollerCallbacks;
    private readonly intervalMs: number;
    private readonly initialDelayMs: number;
    private readonly cloudAuth: boolean;
    private readonly neverDrop: ReadonlyArray<string>;
    private readonly onTickComplete?: (r: SyncTickResult) => void;
    private readonly log: { info: (m: string) => void; error: (m: string) => void };

    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private inflight: Promise<SyncTickResult> | null = null;

    constructor(opts: SyncPollerOptions) {
        this.client = opts.client;
        this.cb = opts.callbacks;
        this.intervalMs = opts.intervalMs ?? 60_000;
        this.initialDelayMs = opts.initialDelayMs ?? 1_000;
        this.cloudAuth = opts.cloudIsAuthoritative;
        this.neverDrop = opts.neverDrop ?? [];
        this.onTickComplete = opts.onTickComplete;
        this.log = opts.log ?? { info: (m) => console.log(m), error: (m) => console.error(m) };
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.schedule(this.initialDelayMs);
    }

    /**
     * SP-02 — async graceful stop. Clears the next-tick timer AND awaits
     * any in-flight tick so a reconcile mid-`applySnapshot` (per-workspace
     * snapshot fs.writeFile) is never interrupted by `process.exit`,
     * which would leave a half-written snapshot file on disk.
     */
    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.inflight) await this.inflight.catch(() => { /* drained; tick errors handled in runTick */ });
    }

    /** Run one reconcile tick immediately. Exposed for tests + on-demand triggers. */
    async tickOnce(): Promise<SyncTickResult> {
        if (this.inflight) return this.inflight;
        this.inflight = this.runTick();
        try { return await this.inflight; }
        finally { this.inflight = null; }
    }

    private schedule(delayMs: number): void {
        if (!this.running) return;
        this.timer = setTimeout(async () => {
            await this.tickOnce();
            if (this.running) this.schedule(this.intervalMs);
        }, delayMs);
    }

    private async runTick(): Promise<SyncTickResult> {
        const result: SyncTickResult = {
            pullsApplied: [], pullsFailed: [], dropsApplied: [], dropsFailed: [],
            completedAt: '',
        };

        try {
            const reachable = await this.client.isReachable();
            if (!reachable) {
                result.skipped = 'unreachable';
                result.completedAt = new Date().toISOString();
                this.log.info('[sync] cloud unreachable; skipping tick');
                this.onTickComplete?.(result);
                return result;
            }

            // RA2-reaudit2 (CRITICAL) — a FAILED cloud-list is not an empty
            // cloud. listMyWorkspaces now throws on 401/5xx/network; treat that
            // as skip-the-tick (no reconcile, no drops) so a transient cloud
            // blip can't wipe every local workspace.
            let cloud: SyncedWorkspace[];
            try {
                cloud = await this.client.listMyWorkspaces();
            } catch (e) {
                result.skipped = 'workspace-list-failed';
                result.completedAt = new Date().toISOString();
                this.log.error(`[sync] listMyWorkspaces failed; skipping tick (no drops): ${(e as Error).message}`);
                this.onTickComplete?.(result);
                return result;
            }
            const local = await this.cb.readLocalState();
            let plan: ReconcilePlan;
            try {
                plan = reconcile({
                    cloud, local,
                    cloudIsAuthoritative: this.cloudAuth,
                    neverDrop: this.neverDrop,
                });
            } catch (e) {
                result.skipped = 'reconcile-failed';
                result.completedAt = new Date().toISOString();
                this.log.error(`[sync] reconcile failed: ${(e as Error).message}`);
                this.onTickComplete?.(result);
                return result;
            }
            result.plan = plan;
            this.log.info(`[sync] ${summarizePlan(plan)}`);

            // Execute pulls.
            for (const p of plan.pull) {
                try {
                    const snap = await this.client.pullWorkspaceSnapshot(p.workspaceId, p.cloudVersion);
                    if (!snap) {
                        result.pullsFailed.push({ workspaceId: p.workspaceId, reason: 'snapshot_null' });
                        continue;
                    }
                    await this.cb.applySnapshot(snap.workspaceId, snap.version, snap.bytes);
                    result.pullsApplied.push({ workspaceId: snap.workspaceId, version: snap.version });
                } catch (e) {
                    result.pullsFailed.push({ workspaceId: p.workspaceId, reason: (e as Error).message });
                }
            }

            // Execute drops.
            for (const d of plan.drop) {
                try {
                    await this.cb.removeWorkspace(d.workspaceId);
                    result.dropsApplied.push(d.workspaceId);
                } catch (e) {
                    result.dropsFailed.push({ workspaceId: d.workspaceId, reason: (e as Error).message });
                }
            }
        } catch (e) {
            this.log.error(`[sync] tick threw: ${(e as Error).message}`);
        }

        result.completedAt = new Date().toISOString();
        this.onTickComplete?.(result);
        return result;
    }
}
