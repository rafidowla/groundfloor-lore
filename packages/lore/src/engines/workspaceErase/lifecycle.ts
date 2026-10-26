/**
 * workspaceErase/lifecycle.ts — honest workspace delete: hide at once, erase after a recovery window (lane f6b).
 *
 * `deleteWorkspaceWithLifecycle` is the ONE delete entry point for the HTTP route and the maintain registry:
 *   1. refuse what `deleteWorkspace` refuses (bootstrap / active / unknown) BEFORE touching anything;
 *   2. close the workspace's open handles (refuse if they cannot be closed);
 *   3. atomically rename the data dir to the hidden holding folder `.erase-hold-<id>`;
 *   4. close handles again (a request could have reopened one between 2 and 3) — roll the rename back on refusal;
 *   5. append the `deleted` record (with `eraseAfter`, `holdingPath`, the entry snapshot) and remove the registry
 *      entry — `deleteWorkspace` does both, record first;
 *   6. when the window is 0 (or erase-now), run the erasers at once.
 * `runErase` is the lock-free core that runs the erasers in order and writes the receipt; callers hold the erase
 * lock (see `lock.ts`). A workspace whose data another live entry still references (an alias) is never moved or
 * erased: the registry entry goes, the data stays.
 */

import { appendEraseFailedEvent, appendErasedEvent, deletionKeepsDataLive, deletionIdOf, liveWorkspaceIds, readDeletionLog,
    type DeletionRecord, type DeletionState, type ErasedEvent } from '../../config/deletedWorkspaces.js';
import { loreHome } from '../../config/loreHome.js';
import { deleteWorkspace, loadWorkspaces, type WorkspaceEntry, type WorkspacesFile } from '../../config/workspaces.js';
import { redactError } from '../../security/logRedact.js';
import { closeWorkspaceHandles, type HandleSources } from './closeHandles.js';
import { readEraseWindow, readMaxUnverifiableAttempts } from './config.js';
import { buildWorkspaceErasers, type EraserFactoryDeps } from './factory.js';
import { buildHostErasers, engineOfEntry } from './hostErasers.js';
import { holdWorkspaceDir, releaseHold } from './localDir.js';
import { readLiveEntriesStrict } from './liveRegistry.js';
import { withEraseLock, type EraseLockOptions } from './lock.js';
import type { EraseStepResult, EraseTarget, WorkspaceEraser } from './types.js';

export interface LifecycleDeps {
    /** Lore home whose registry / deletion log this operates on. Default: the process Lore home. */
    home?: string;
    handles?: HandleSources;
    /** Fully replaces the erasers (tests). Default: `buildWorkspaceErasers`. */
    erasers?: readonly WorkspaceEraser[];
    /** Options for the default factory, and the plug-in slot for the Postgres + blob erasers (lane f6a). */
    eraserFactory?: Omit<EraserFactoryDeps, 'home'>;
    extraErasers?: readonly WorkspaceEraser[];
    now?: () => Date;
    env?: Record<string, string | undefined>;
    lock?: EraseLockOptions;
    /** Test seam: shorten the scheduled tick's first-run delay / interval (wire-up tests only). */
    tick?: { firstRunMs?: number; intervalMs?: number };
}

/**
 * Process-wide defaults merged under every call's own deps. TEST SEAM ONLY: the wire-up tests use it to keep the
 * real daemon / embedded host off the machine's OS keychain and to fake the clock and Dataplane. Production never sets it.
 */
let testDefaults: LifecycleDeps = {};
export function setLifecycleTestDefaults(d: LifecycleDeps | null): void { testDefaults = d ?? {}; }
const eff = (d: LifecycleDeps): LifecycleDeps => ({ ...testDefaults, ...d });

export const homeOf = (d: LifecycleDeps): string => eff(d).home ?? loreHome();
export const nowOf = (d: LifecycleDeps): Date => (eff(d).now ?? (() => new Date()))();
export const lockOf = (d: LifecycleDeps): EraseLockOptions => eff(d).lock ?? {};
export const envOf = (d: LifecycleDeps): Record<string, string | undefined> => eff(d).env ?? process.env;
export const tickTimingOf = (d: LifecycleDeps): { firstRunMs?: number; intervalMs?: number } => eff(d).tick ?? {};
export const handlesOf = (d: LifecycleDeps): HandleSources => eff(d).handles ?? {};

export function resolveErasers(d0: LifecycleDeps): WorkspaceEraser[] {
    const d = eff(d0);
    if (d.erasers) return [...d.erasers];
    // Lane f6c: the Postgres + uploaded-file erasers (lane f6a) are part of every default run: daemon tick, embedded host,
    // HTTP/CLI erase-now and the maintain expiry all resolve their erasers here.
    const extra = d.extraErasers ?? [];
    const taken = new Set(extra.map((e) => e.store));
    const host = buildHostErasers({ home: homeOf(d0), ...(d.env ? { env: d.env } : {}) }).filter((e) => !taken.has(e.store)); // a caller-supplied eraser for a store replaces ours
    return buildWorkspaceErasers({ home: homeOf(d0), ...(d.env ? { env: d.env } : {}), ...(d.eraserFactory ?? {}) }, [...host, ...extra]);
}

/* ─── erase core ───────────────────────────────────────────────── */

export type RunEraseOutcome =
    | { kind: 'complete' | 'partial' | 'needs-operator'; receipt: ErasedEvent }
    | { kind: 'failed'; error: string; attempt: number }
    | { kind: 'skipped'; reason: string };

/** What an eraser is told about the workspace, taken from its deletion record. `holdingPath` undefined = legacy record. */
export function targetFromRecord(rec: DeletionRecord): EraseTarget {
    return {
        id: rec.id, name: rec.name, path: rec.path, mode: rec.mode, orgId: rec.orgId,
        holdingPath: rec.eraseAfter !== undefined ? (rec.holdingPath ?? null) : undefined,
        engine: engineOfEntry(rec.entry),
        createdAt: rec.createdAt, deletedAt: rec.deletedAt,
    };
}

/** Redact, then also scrub `key=value` secret text that a driver error may carry, and cap the length. */
const fmtErr = (e: unknown): string =>
    redactError(e).replace(/(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+/gi, '$1$2[redacted]').slice(0, 500);

/**
 * Run every eraser, in order, for the latest deletion of `id`; write the receipt. Stops at the first eraser that
 * reports `partial` or throws; an `unverifiable` step does not stop the run but makes the overall receipt
 * `partial` (never `complete`), so the record stays due and is retried (later stores depend on earlier ones: blobs before rows).
 * When every non-complete step stays `unverifiable` for `LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS` consecutive attempts
 * (a `partial` step or a failure resets the count), the receipt is `needs-operator`: the tick stops retrying; `manual` (erase-now) still runs it, count reset. Safe to repeat. The caller
 * holds the erase lock. Never erases an id that is live in the registry, restored, or already erased.
 */
export async function runErase(id: string, d: LifecycleDeps, opts: { manual?: boolean } = {}): Promise<RunEraseOutcome> {
    const home = homeOf(d);
    const state = readDeletionLog(home).byId.get(id);
    const rec = state?.deletion;
    if (!rec) return { kind: 'skipped', reason: 'no deletion record for this id' };
    if (state!.restored) return { kind: 'skipped', reason: 'the workspace was restored' };
    if (state!.completedErase) return { kind: 'skipped', reason: 'already erased' };
    // `needs-operator` is terminal for the scheduled tick; only a manual run (`erase-now`) retries it, with the counter reset.
    if (state!.needsOperator && !opts.manual) return { kind: 'skipped', reason: 'needs an operator (some stores cannot be verified); retry with: lore workspaces erase-now ' + id };
    let live: WorkspaceEntry[];
    try { live = readLiveEntriesStrict(home); }
    catch (e) { return { kind: 'skipped', reason: `the workspace registry cannot be read (${(e as Error).message})` }; }
    if (liveWorkspaceIds(live).has(id)) return { kind: 'skipped', reason: 'the id is live in the registry (delete not finished or workspace re-created)' };

    const target = targetFromRecord(rec);
    const stores: EraseStepResult[] = [];
    let overall: 'complete' | 'partial' = 'complete';
    for (const eraser of resolveErasers(d)) {
        let r: EraseStepResult;
        try { r = await eraser.erase(target); }
        catch (e) {
            const attempt = state!.attempts + 1;
            try { appendEraseFailedEvent({ id, attempt, error: `${eraser.store}: ${fmtErr(e)}`, at: nowOf(d).toISOString() }, home); } catch { /* the retry still happens: no receipt = still due */ }
            return { kind: 'failed', error: `${eraser.store}: ${fmtErr(e)}`, attempt };
        }
        stores.push(r);
        if (r.status === 'partial') { overall = 'partial'; break; }
        // 'unverifiable' = the store could not prove it holds nothing (a non-destructive no-op, e.g. Postgres is keyed by
        // name, not id). The receipt must never say 'complete' then; keep going so the stores we CAN erase still are.
        if (r.status === 'unverifiable') overall = 'partial';
    }
    // Consecutive all-unverifiable attempts: a `partial` step (a real failure that may clear) never counts and resets the run.
    const onlyUnverifiable = stores.every((s) => s.status === 'complete' || s.status === 'not-applicable' || s.status === 'unverifiable') && stores.some((s) => s.status === 'unverifiable');
    const streak = onlyUnverifiable ? (opts.manual ? 0 : state!.unverifiableStreak) + 1 : 0;
    const status = overall === 'partial' && onlyUnverifiable && streak >= readMaxUnverifiableAttempts(envOf(d)) ? 'needs-operator' : overall;
    const receipt = appendErasedEvent({ id, status, stores, at: nowOf(d).toISOString(), unverifiableStreak: streak }, home);
    return { kind: status, receipt };
}

/** Acquire the erase lock and `runErase`. `{ busy: true }` when another process is erasing. */
export async function runEraseLocked(id: string, d: LifecycleDeps, opts: { manual?: boolean } = {}): Promise<RunEraseOutcome | { kind: 'busy' }> {
    const r = await withEraseLock(homeOf(d), () => runErase(id, d, opts), lockOf(d));
    return r.ran ? r.value : { kind: 'busy' };
}

/* ─── delete ───────────────────────────────────────────────────── */

/** The refusals `deleteWorkspace` applies, run BEFORE any data is moved so a refused delete never touches the dir. */
function assertDeletable(name: string, home: string): WorkspaceEntry {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    if (entry.path === home) throw new Error('Cannot delete the legacy/bootstrap workspace (path is the Lore home)');
    if (file.active === name) throw new Error('Cannot delete the active workspace');
    return entry;
}

export interface DeleteLifecycleOptions {
    /** Erase at once (HTTP `?erase=now`, CLI, maintain expiry). Overrides the window. */
    eraseNow?: boolean;
    /** Recovery window in days; default from `LORE_WORKSPACE_ERASE_AFTER_DAYS`. 0 = at once. */
    windowDays?: number;
}

export interface DeleteLifecycleResult {
    file: WorkspacesFile;
    entry: WorkspaceEntry;
    id: string;
    /** 'scheduled' = hidden, erase later; 'erased' / 'erasing' = erase ran now (complete / partial or busy); 'not-scheduled' = data kept live by an alias. */
    status: 'scheduled' | 'erased' | 'erasing' | 'not-scheduled';
    eraseAfter: string | null;
    windowDays: number;
    holdingPath: string | null;
    /** Plain-language note (nothing held, alias, partial). */
    note?: string;
    /** Present when an erase ran as part of the delete. */
    erase?: RunEraseOutcome | { kind: 'busy' };
}

const noteFor = (...parts: Array<string | undefined>): string | undefined => parts.filter(Boolean).join('; ') || undefined;

export async function deleteWorkspaceWithLifecycle(name: string, opts: DeleteLifecycleOptions = {}, d: LifecycleDeps = {}): Promise<DeleteLifecycleResult> {
    const home = homeOf(d);
    const entry = assertDeletable(name, home);
    const id = deletionIdOf(entry);
    const days = opts.eraseNow ? 0 : (opts.windowDays ?? readEraseWindow(envOf(d)).days);
    const now = nowOf(d);
    const eraseAfter = new Date(now.getTime() + days * 86_400_000).toISOString();

    const remaining = loadWorkspaces(home).workspaces.filter((w) => w.name !== name);
    if (deletionKeepsDataLive(entry, remaining)) {
        // Another live entry still uses this data: drop the registry entry only; nothing is moved or erased.
        const file = deleteWorkspace(name, home);
        return { file, entry, id, status: 'not-scheduled', eraseAfter: null, windowDays: days, holdingPath: null,
            note: 'another workspace still uses the same data, so the data was kept' };
    }

    const handles = handlesOf(d);
    const first = await closeWorkspaceHandles(name, handles);
    if (!first.ok) throw new Error(`refusing to delete workspace "${name}": ${first.reason} — retry once it drains`);

    const hold = holdWorkspaceDir(entry, id, home); // throws (nothing moved) on any safety refusal
    const undo = (): void => {
        if (hold.holdingPath && !hold.adopted) { try { releaseHold(hold.holdingPath, entry.path, home); } catch { /* reconcile finishes this */ } }
    };
    try {
        const second = await closeWorkspaceHandles(name, handles);
        if (!second.ok) throw new Error(`refusing to delete workspace "${name}": ${second.reason} — retry once it drains`);
        const file = deleteWorkspace(name, home, { eraseAfter, windowDays: days, holdingPath: hold.holdingPath, now });
        const base: DeleteLifecycleResult = { file, entry, id, status: 'scheduled', eraseAfter, windowDays: days, holdingPath: hold.holdingPath,
            ...(hold.note ? { note: hold.note } : {}) };
        if (days > 0) return base;
        const erase = await runEraseLocked(id, d);
        const status = erase.kind === 'complete' ? 'erased' : 'erasing';
        const detail = erase.kind === 'needs-operator' ? 'some stores cannot be verified; an operator must check them (see: lore workspaces deleted)' : erase.kind === 'partial' ? 'some stores could not be erased yet; the scheduled run retries' : erase.kind === 'failed' ? 'an erase step failed; the scheduled run retries' : erase.kind === 'busy' ? 'another erase is running; the scheduled run continues it' : undefined;
        return { ...base, status, erase, note: noteFor(base.note, detail) };
    } catch (e) {
        // The record may or may not have been written; either way the registry still has the entry (writeControl is
        // atomic), so put the folder back. A written-but-orphaned record is handled by reconcile.
        const stillRegistered = (() => { try { return loadWorkspaces(home).workspaces.some((w) => w.name === name); } catch { return true; } })();
        if (stillRegistered) undo();
        throw e;
    }
}

/** Summary used by listings and the HTTP `erase` field. */
export function describeState(state: DeletionState): { eraseAfter: string | null; attempts: number } {
    return { eraseAfter: state.deletion?.eraseAfter ?? null, attempts: state.attempts };
}
