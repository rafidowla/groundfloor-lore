/**
 * workspaceErase/tick.ts — the scheduled erase run and erase-now (lane f6b).
 *
 * One tick: (1) finish what a crash left half-done (`reconcileDeletions`), (2) erase every deletion whose recovery
 * window has passed and that has no complete receipt, oldest first, with retry backoff for ones that failed or
 * only partly finished. The whole tick runs under the cross-process erase lock, so a daemon, an embedded host and
 * the CLI on one Lore home never erase at the same time. There is deliberately no environment switch that turns the
 * tick off: the recovery window is the only knob.
 */

import { liveWorkspaceIds, readDeletionLog } from '../../config/deletedWorkspaces.js';
import { redactError } from '../../security/logRedact.js';
import { AUTO_ERASE_LEGACY_DELETES, ERASE_TICK_FIRST_RUN_MS, ERASE_TICK_INTERVAL_MS } from './config.js';
import { runErase, runEraseLocked, homeOf, lockOf, nowOf, tickTimingOf, type LifecycleDeps, type RunEraseOutcome } from './lifecycle.js';
import { readLiveEntriesStrict } from './liveRegistry.js';
import { withEraseLock } from './lock.js';
import { nextAttemptAtMs, reconcileDeletions, type ReconcileAction } from './restore.js';

/** Erase at most this many workspaces per tick, so one pass cannot hold the lock for hours. */
export const MAX_ERASES_PER_TICK = 10;

/** Ids whose recovery window has passed and that still need work (selection only; no side effects). */
export function selectDueErasures(d: LifecycleDeps): string[] {
    const home = homeOf(d);
    const nowMs = nowOf(d).getTime();
    let live: Set<string>;
    try { live = liveWorkspaceIds(readLiveEntriesStrict(home)); } catch { return []; }
    const due: Array<{ id: string; at: number }> = [];
    for (const [id, st] of readDeletionLog(home).byId) {
        const rec = st.deletion;
        if (!rec || st.restored || st.completedErase || st.needsOperator || live.has(id)) continue; // needs-operator: only `erase-now` retries
        if (rec.eraseAfter === undefined && !AUTO_ERASE_LEGACY_DELETES) continue; // legacy: kept until `erase-now`
        const dueAt = rec.eraseAfter !== undefined ? Date.parse(rec.eraseAfter) : 0;
        if (!Number.isFinite(dueAt) || dueAt > nowMs) continue;
        if (nextAttemptAtMs(st) > nowMs) continue; // backing off after a failed / partial attempt
        due.push({ id, at: dueAt });
    }
    return due.sort((a, b) => a.at - b.at).map((x) => x.id);
}

export interface EraseTickResult {
    /** False when another process held the lock (nothing was done). */
    ran: boolean;
    reconciled: ReconcileAction[];
    outcomes: Array<{ id: string; outcome: RunEraseOutcome }>;
}

export async function runEraseTick(d: LifecycleDeps, opts: { max?: number } = {}): Promise<EraseTickResult> {
    const home = homeOf(d);
    const r = await withEraseLock(home, async () => {
        const reconciled = reconcileDeletions(d);
        const outcomes: EraseTickResult['outcomes'] = [];
        for (const id of selectDueErasures(d).slice(0, opts.max ?? MAX_ERASES_PER_TICK)) {
            outcomes.push({ id, outcome: await runErase(id, d) });
        }
        return { reconciled, outcomes };
    }, lockOf(d));
    return r.ran ? { ran: true, ...r.value } : { ran: false, reconciled: [], outcomes: [] };
}

/** Erase one deleted workspace now, skipping the recovery window and any retry backoff. Legacy records are allowed. */
export async function eraseNow(id: string, d: LifecycleDeps = {}): Promise<RunEraseOutcome> {
    const home = homeOf(d);
    const st = readDeletionLog(home).byId.get(id);
    if (!st?.deletion) throw new Error(`no deleted workspace with id "${id}" (see: lore workspaces deleted)`);
    if (st.restored) throw new Error(`workspace "${st.deletion.name}" was restored; it is not deleted`);
    if (st.completedErase) throw new Error(`workspace "${st.deletion.name}" was already erased`);
    const r = await runEraseLocked(id, d, { manual: true }); // manual: also retries a needs-operator record, with the counter reset
    if (r.kind === 'busy') throw new Error('another Lore process is erasing workspaces right now; try again in a minute');
    return r;
}

export interface EraseTickHandle {
    stop(): Promise<void>;
    /** Run one tick now (tests, and the first-run kick). Never throws. */
    runNow(): Promise<EraseTickResult | null>;
}

export interface StartEraseTickOptions {
    deps: LifecycleDeps;
    firstRunMs?: number;
    intervalMs?: number;
    log?: (msg: string) => void;
}

/** Schedule the erase tick: first run shortly after start, then hourly. Timers are unref'd; `stop()` is idempotent and awaits a run in flight. */
export function startEraseTick(opts: StartEraseTickOptions): EraseTickHandle {
    const log = opts.log ?? ((m: string) => console.error(m));
    let stopped = false;
    let inFlight: Promise<EraseTickResult | null> | null = null;
    const once = (): Promise<EraseTickResult | null> => {
        if (stopped) return Promise.resolve(null);
        if (inFlight) return inFlight;
        inFlight = (async () => {
            try {
                const res = await runEraseTick(opts.deps);
                for (const a of res.reconciled) log(`[Lore] workspace erase: ${a.action} ${a.id}: ${a.detail}`);
                for (const o of res.outcomes) {
                    const o2 = o.outcome;
                    log(`[Lore] workspace erase: ${o.id} ${o2.kind}${o2.kind === 'failed' ? ` (${o2.error})` : o2.kind === 'skipped' ? ` (${o2.reason})` : ''}`);
                }
                return res;
            } catch (e) {
                log(`[Lore] workspace erase tick failed: ${redactError(e).slice(0, 300)}`);
                return null;
            } finally { inFlight = null; }
        })();
        return inFlight;
    };
    const first = setTimeout(() => { void once(); }, opts.firstRunMs ?? tickTimingOf(opts.deps).firstRunMs ?? ERASE_TICK_FIRST_RUN_MS);
    const every = setInterval(() => { void once(); }, opts.intervalMs ?? tickTimingOf(opts.deps).intervalMs ?? ERASE_TICK_INTERVAL_MS);
    first.unref?.(); every.unref?.();
    return {
        runNow: once,
        async stop(): Promise<void> {
            stopped = true;
            clearTimeout(first); clearInterval(every);
            if (inFlight) { try { await inFlight; } catch { /* already logged */ } }
        },
    };
}
