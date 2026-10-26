/**
 * workspaceErase/restore.ts — undo a delete inside the recovery window, finish half-done deletes/restores, and
 * list what is pending (lane f6b).
 *
 * Restore puts the SAME permanent id back. Order matters for crash safety: the `restored` event is written FIRST
 * (it stops every erase for that id), then the held folder is moved back, then the registry entry is re-added.
 * A crash between those steps is finished by `reconcileDeletions`. Restore needs the registry entry snapshot that
 * only lifecycle-era records carry; legacy records cannot be restored (their data was never moved).
 */

import fs from 'node:fs';
import path from 'node:path';
import { appendRestoredEvent, deletionIdOf, liveWorkspaceIds, readDeletionLog, type DeletionState } from '../../config/deletedWorkspaces.js';
import { kebabCase, loadWorkspaces, writeControl, type WorkspaceEntry } from '../../config/workspaces.js';
import { AUTO_ERASE_LEGACY_DELETES, eraseRetryDelayMs } from './config.js';
import { liveClaims, readLiveEntriesStrict } from './liveRegistry.js';
import { HOLD_PREFIX, holdingPathFor, isUnderManagedDir, managedWorkspacesDir, releaseHold } from './localDir.js';
import { withEraseLock } from './lock.js';
import { homeOf, lockOf, nowOf, type LifecycleDeps } from './lifecycle.js';

const exists = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };

/* ─── restore ──────────────────────────────────────────────────── */

export interface RestoreOptions { as?: string }
export interface RestoreResult { id: string; name: string; path: string; renamed: boolean }

function addEntry(entry: WorkspaceEntry, home: string): void {
    const file = loadWorkspaces(home);
    if (file.workspaces.some((w) => w.name === entry.name)) throw new Error(`workspace name "${entry.name}" is already registered`);
    file.workspaces.push(entry);
    writeControl(file, home);
}

export async function restoreWorkspace(id: string, opts: RestoreOptions = {}, d: LifecycleDeps = {}): Promise<RestoreResult> {
    const home = homeOf(d);
    const r = await withEraseLock(home, async () => restoreLocked(id, opts, d), lockOf(d));
    if (!r.ran) throw new Error('another Lore process is erasing or restoring workspaces right now; try again in a minute');
    return r.value;
}

function restoreLocked(id: string, opts: RestoreOptions, d: LifecycleDeps): RestoreResult {
    const home = homeOf(d);
    const state = readDeletionLog(home).byId.get(id);
    const rec = state?.deletion;
    if (!rec) throw new Error(`no deleted workspace with id "${id}" (see: lore workspaces deleted)`);
    if (state!.restored) throw new Error(`workspace "${rec.name}" was already restored`);
    if (state!.eraseStarted || state!.completedErase) throw new Error(`cannot restore "${rec.name}": its erase has already started, so its data may be gone`);
    if (!rec.entry) throw new Error(`cannot restore "${rec.name}": it was deleted before restore was supported (a legacy delete); its data was never moved, so re-register it by hand or run: lore workspaces erase-now ${id}`);
    const live = readLiveEntriesStrict(home);
    if (liveWorkspaceIds(live).has(id)) throw new Error(`workspace id "${id}" is already live in the registry`);

    const renamed = opts.as !== undefined && kebabCase(opts.as) !== rec.entry.name;
    const name = opts.as !== undefined ? kebabCase(opts.as) : rec.entry.name;
    if (!name) throw new Error('the new name is empty after normalisation');
    const dest = renamed ? path.join(managedWorkspacesDir(home), name) : rec.entry.path;
    const claim = liveClaims(live, { id, name, paths: [dest] });
    if (claim.byName) throw new Error(`cannot restore: the name "${name}" is now used by another workspace. Restore under a different name: lore workspaces restore ${id} --as <new-name>`);
    if (claim.byPath) throw new Error(`cannot restore: the folder ${dest} is now used by another workspace. Restore under a different name: lore workspaces restore ${id} --as <new-name>`);

    const hold = rec.holdingPath ?? null;
    if (hold) {
        if (!exists(hold)) throw new Error(`cannot restore "${rec.name}": its holding folder ${hold} is missing`);
        if (exists(dest)) throw new Error(`cannot restore: ${dest} already exists on disk. Restore under a different name: lore workspaces restore ${id} --as <new-name>`);
        if (!isUnderManagedDir(dest, home)) throw new Error(`cannot restore into ${dest}: it is outside the managed workspaces folder`);
    }
    appendRestoredEvent({ id, name, path: dest, at: nowOf(d).toISOString() }, home); // stops every erase for this id
    if (hold) releaseHold(hold, dest, home);
    addEntry({ ...rec.entry, name, path: dest }, home);
    return { id, name, path: dest, renamed };
}

/* ─── reconcile ────────────────────────────────────────────────── */

export interface ReconcileOptions { graceMs?: number }
export interface ReconcileAction { id: string; action: 'finished-delete' | 'rolled-back-hold' | 'finished-restore' | 'marked-stale' | 'left-alone'; detail: string }

const DEFAULT_GRACE_MS = 10 * 60 * 1000;

/**
 * Finish what a crash left half-done. Only ever moves a folder BACK to a live registry entry or completes a
 * delete/restore whose durable record exists; it never erases anything and never touches an unproven folder.
 * Run under the erase lock (the tick does).
 */
export function reconcileDeletions(d: LifecycleDeps, opts: ReconcileOptions = {}): ReconcileAction[] {
    const home = homeOf(d);
    const grace = opts.graceMs ?? DEFAULT_GRACE_MS;
    const nowMs = nowOf(d).getTime();
    const actions: ReconcileAction[] = [];
    let live: WorkspaceEntry[];
    try { live = readLiveEntriesStrict(home); } catch { return actions; }
    const byIdLive = (id: string): WorkspaceEntry | undefined => live.find((w) => (typeof w.id === 'string' && w.id !== '' ? w.id : deletionIdOf(w)) === id);
    const log = readDeletionLog(home);

    for (const [id, st] of log.byId) {
        const rec = st.deletion;
        if (!rec) continue;
        const liveEntry = byIdLive(id);
        const hold = rec.holdingPath ?? null;
        try {
            if (st.restored) {
                // C — interrupted restore: finish moving the folder back and re-adding the entry.
                if (liveEntry || !rec.entry) continue;
                const dest = st.restored.path ?? rec.entry.path;
                const name = st.restored.name;
                if (hold && exists(hold)) {
                    if (exists(dest)) { actions.push({ id, action: 'left-alone', detail: `restore of "${name}" is blocked: ${dest} already exists` }); continue; }
                    releaseHold(hold, dest, home);
                }
                if (hold && !exists(dest)) { actions.push({ id, action: 'left-alone', detail: `restore of "${name}": neither the holding folder nor ${dest} exists` }); continue; }
                const claim = liveClaims(live, { id, name, paths: [dest] });
                if (claim.byName || claim.byPath) { actions.push({ id, action: 'left-alone', detail: `restore of "${name}" is blocked: name or folder now in use` }); continue; }
                addEntry({ ...rec.entry, name, path: dest }, home);
                live = readLiveEntriesStrict(home);
                actions.push({ id, action: 'finished-restore', detail: `finished restoring "${name}"` });
                continue;
            }
            if (rec.eraseAfter === undefined || st.completedErase || st.eraseStarted) continue;
            if (!liveEntry) continue;
            if (nowMs - Date.parse(rec.deletedAt) < grace) continue;
            const holdThere = hold !== null && exists(hold);
            if (holdThere && !exists(liveEntry.path)) {
                // A — record written, registry removal never happened. The delete was committed: finish it.
                const file = loadWorkspaces(home);
                if (file.active === liveEntry.name) { actions.push({ id, action: 'left-alone', detail: `"${liveEntry.name}" is now the active workspace; not removing it` }); continue; }
                file.workspaces = file.workspaces.filter((w) => w.name !== liveEntry.name);
                writeControl(file, home);
                live = readLiveEntriesStrict(home);
                actions.push({ id, action: 'finished-delete', detail: `finished deleting "${liveEntry.name}"` });
            } else if (!holdThere) {
                // Registry write failed after the record: the workspace is still live and its folder in place.
                appendRestoredEvent({ id, name: liveEntry.name, path: liveEntry.path, at: nowOf(d).toISOString() }, home);
                actions.push({ id, action: 'marked-stale', detail: `delete of "${liveEntry.name}" never completed; marked as not deleted` });
            }
        } catch (e) {
            actions.push({ id, action: 'left-alone', detail: `could not reconcile: ${(e as Error).message}` });
        }
    }

    // B — a holding folder with no deletion record: crash between the rename and the record.
    const dir = managedWorkspacesDir(home);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { /* no workspaces dir */ }
    for (const n of names) {
        if (!n.startsWith(HOLD_PREFIX)) continue;
        const id = n.slice(HOLD_PREFIX.length);
        const holdPath = path.join(dir, n);
        if (holdingPathFor(home, id) !== holdPath) continue;
        const st: DeletionState | undefined = log.byId.get(id);
        if (st?.deletion && !st.restored && st.deletion.holdingPath === holdPath) continue; // a recorded, pending delete
        const liveEntry = byIdLive(id);
        try {
            const age = nowMs - fs.lstatSync(holdPath).ctimeMs;
            if (age < grace) continue;
            if (liveEntry && !exists(liveEntry.path) && (!st?.deletion || st.restored)) {
                releaseHold(holdPath, liveEntry.path, home);
                actions.push({ id, action: 'rolled-back-hold', detail: `put the folder of "${liveEntry.name}" back (delete never recorded)` });
            } else if (!liveEntry && !st?.deletion) {
                actions.push({ id, action: 'left-alone', detail: `holding folder ${holdPath} has no deletion record and no live workspace; left untouched` });
            }
        } catch (e) {
            actions.push({ id, action: 'left-alone', detail: `could not reconcile ${holdPath}: ${(e as Error).message}` });
        }
    }
    return actions;
}

/* ─── listing ──────────────────────────────────────────────────── */

export type DeletedRowState = 'pending' | 'retrying' | 'erased' | 'partial' | 'needs-operator' | 'restored' | 'kept-legacy';

export interface DeletedRow {
    id: string;
    name: string;
    state: DeletedRowState;
    deletedAt: string;
    eraseAfter: string | null;
    attempts: number;
    /** One plain-language line for the table. */
    summary: string;
    /** Per-store lines of the latest receipt (erased / partial). */
    receipt?: Array<{ store: string; status: string; removed?: unknown; remaining?: unknown; detail?: string }>;
    restorable: boolean;
    /** Consecutive all-unverifiable attempts so far (0 when none). */
    unverifiableAttempts?: number;
    /** Set for `needs-operator`: one line per store that is not complete, with the reason. */
    reasons?: Array<{ store: string; status: string; reason: string }>;
}

const dateOnly = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '?');

export function describeDeletion(st: DeletionState, live: Set<string>): DeletedRow | null {
    const rec = st.deletion;
    if (!rec) return null;
    const base = { id: rec.id, name: rec.name, deletedAt: rec.deletedAt, eraseAfter: rec.eraseAfter ?? null, attempts: st.attempts };
    if (st.restored) return { ...base, state: 'restored', summary: `restored on ${dateOnly(st.restored.at)} as "${st.restored.name}"`, restorable: false };
    if (live.has(rec.id)) return null; // stale record for a live workspace
    if (st.completedErase) {
        return { ...base, state: 'erased', summary: `erased on ${dateOnly(st.completedErase.at)}`, receipt: st.completedErase.stores as DeletedRow['receipt'], restorable: false };
    }
    if (rec.eraseAfter === undefined) {
        return { ...base, state: 'kept-legacy', summary: AUTO_ERASE_LEGACY_DELETES ? 'legacy delete; will be erased automatically' : 'kept — legacy delete (erase with: lore workspaces erase-now ' + rec.id + ')', restorable: false };
    }
    if (st.needsOperator) {
        const reasons = (st.needsOperator.stores as Array<{ store: string; status: string; detail?: string }>)
            .filter((x) => x.status === 'unverifiable').map((x) => ({ store: x.store, status: x.status, reason: x.detail ?? 'cannot be verified' }));
        const why = reasons.map((x) => `${x.store}: ${x.reason}`).join('; ');
        return { ...base, state: 'needs-operator', summary: `needs an operator since ${dateOnly(st.needsOperator.at)} — Lore cannot verify and stopped retrying (${why}); check it, then run: lore workspaces erase-now ${rec.id}`,
            receipt: st.needsOperator.stores as DeletedRow['receipt'], restorable: false, unverifiableAttempts: st.unverifiableStreak, reasons };
    }
    if (st.lastErased && st.lastErased.status === 'partial') {
        const unv = (st.lastErased.stores as Array<{ store: string; status: string }>).filter((x) => x.status === 'unverifiable').map((x) => x.store);
        const why = unv.length ? `; could not verify: ${unv.join(', ')}` : '';
        return { ...base, state: 'partial', summary: `not fully erased as of ${dateOnly(st.lastErased.at)}${why}; retrying (attempt ${st.attempts})`, receipt: st.lastErased.stores as DeletedRow['receipt'], restorable: false };
    }
    if (st.lastFailure || st.attempts > 0) {
        return { ...base, state: 'retrying', summary: `erase failed ${st.attempts} time(s); retrying${st.lastFailure ? ` (last: ${st.lastFailure.error.slice(0, 120)})` : ''}`, restorable: false };
    }
    return { ...base, state: 'pending', summary: `hidden; erase scheduled for ${dateOnly(rec.eraseAfter)}`, restorable: !!rec.entry && !st.eraseStarted };
}

export function listDeletions(d: LifecycleDeps = {}): DeletedRow[] {
    const home = homeOf(d);
    let live = new Set<string>();
    try { live = liveWorkspaceIds(readLiveEntriesStrict(home)); } catch { /* list anyway */ }
    const rows: DeletedRow[] = [];
    for (const st of readDeletionLog(home).byId.values()) {
        const row = describeDeletion(st, live);
        if (row) rows.push(row);
    }
    return rows.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** Next time a failed/partial erase may be retried (ms since epoch), or 0 when it may run now. */
export function nextAttemptAtMs(st: DeletionState): number {
    if (st.attempts <= 0) return 0;
    const last = Math.max(Date.parse(st.lastFailure?.at ?? '') || 0, Date.parse(st.lastErased?.at ?? '') || 0);
    return last + eraseRetryDelayMs(st.attempts);
}
