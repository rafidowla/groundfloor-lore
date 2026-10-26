/**
 * workspaceErase/localDir.ts — the local-data-dir half of honest workspace delete (lane f6b).
 *
 * Three jobs, all sharing one set of safety checks (extracted from `engines/maintain/adapters.ts`
 * `WorkspaceRegistry.delete`, which now calls `assertMovableDir` too):
 *   1. `holdWorkspaceDir`  — at delete time, atomically rename the workspace's data dir to a hidden holding
 *      folder `<home>/workspaces/.erase-hold-<permanent id>`. The registered path is then either fully
 *      present or fully gone, a NEW workspace of the same name can never pick up the old folder, and the
 *      holding name carries the id so only that workspace's erase can ever remove it.
 *   2. `releaseHold`       — restore: rename the holding folder back.
 *   3. `createLocalDirEraser` — erase time: remove the holding folder (or, for a legacy delete, move the
 *      old registered folder to the holding name first, then remove it), verified by a fresh stat.
 *
 * Safety rules (every one refuses rather than guesses):
 *   - Only paths strictly under `<home>/workspaces/`, never the Lore home itself.
 *   - lstat: never a symlink (a rename would move the link, not the data), always a directory.
 *   - Mount point: device id must equal the workspaces dir's; no directory INSIDE the tree may sit on another
 *     device either (recursive removal would cross into the mounted volume).
 *   - The eraser refuses (`not-applicable`) while ANY live registry entry has the same id or the same path,
 *     and when the registry cannot be read (strict read).
 *   - The holding path must be exactly `.erase-hold-<id>` for the target's id — a recorded path that differs
 *     is not trusted.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EraseOptions, EraseStepResult, EraseTarget, WorkspaceEraser } from './types.js';
import { liveClaims, readLiveEntriesStrict } from './liveRegistry.js';
import type { WorkspaceEntry } from '../../config/workspaces.js';

export const HOLD_PREFIX = '.erase-hold-';

export const managedWorkspacesDir = (home: string): string => path.join(home, 'workspaces');

/** The hidden holding path for a permanent id. Deterministic, so a crashed attempt is found again. */
export function holdingPathFor(home: string, id: string): string {
    return path.join(managedWorkspacesDir(home), `${HOLD_PREFIX}${id}`);
}

/** True when `p` is strictly under `<home>/workspaces/` (not the dir itself, not the home). */
export function isUnderManagedDir(p: string, home: string): boolean {
    const resolved = path.resolve(p);
    return resolved !== path.resolve(home) && resolved.startsWith(path.resolve(managedWorkspacesDir(home)) + path.sep);
}

/**
 * QA round 4 (2026-09-03) checks, extracted verbatim from adapters.ts: refuse a symlink, a non-directory
 * and a mount point BEFORE a rename. `name` only labels the error. Throws `refusing to delete workspace ...`.
 */
export function assertMovableDir(resolved: string, workspacesDir: string, name: string): fs.Stats {
    let liveStat: fs.Stats;
    try {
        liveStat = fs.lstatSync(resolved);
    } catch (err) {
        throw new Error(`refusing to delete workspace "${name}": could not stat its directory (${(err as Error).message})`);
    }
    if (liveStat.isSymbolicLink()) {
        throw new Error(`refusing to delete workspace "${name}": its registered path (${resolved}) is a symlink — refusing to rename or follow it into a sideline (the real target would be silently orphaned); fix the registry entry or remove the symlink by hand`);
    }
    if (!liveStat.isDirectory()) {
        throw new Error(`refusing to delete workspace "${name}": its registered path (${resolved}) is not a directory`);
    }
    let parentStat: fs.Stats;
    try {
        parentStat = fs.statSync(workspacesDir);
    } catch (err) {
        throw new Error(`refusing to delete workspace "${name}": could not stat the workspaces directory (${(err as Error).message})`);
    }
    if (liveStat.dev !== parentStat.dev) {
        throw new Error(`refusing to delete workspace "${name}": its directory (${resolved}) is a mount point — a separate filesystem grafted onto the workspaces dir (device ${liveStat.dev} vs parent device ${parentStat.dev}). Renaming it aside would move the mount itself and a subsequent cleanup pass would destroy the mounted volume's contents. Unmount it first, then retry.`);
    }
    return liveStat;
}

/* ─── hold / release ───────────────────────────────────────────── */

export interface HoldResult {
    /** The hidden holding folder now containing the data, or null when nothing was (or could be) held. */
    holdingPath: string | null;
    /** True when the folder was already at the holding path (a crashed earlier attempt) and was adopted. */
    adopted: boolean;
    /** Plain-language note when nothing was held (outside the managed dir / no folder). */
    note?: string;
}

const lstatOrNull = (p: string): fs.Stats | null => {
    try { return fs.lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
};

/**
 * Hide the workspace's data dir. Call only after the handles are closed and after confirming no alias keeps
 * the same data live. Throws (nothing moved) on any safety refusal.
 */
export function holdWorkspaceDir(entry: Pick<WorkspaceEntry, 'name' | 'path'>, id: string, home: string): HoldResult {
    const resolved = path.resolve(entry.path);
    if (!isUnderManagedDir(resolved, home)) {
        return { holdingPath: null, adopted: false, note: `its data folder (${resolved}) is outside Lore's managed workspaces folder, so it was left in place and is not erased by Lore` };
    }
    const workspacesDir = managedWorkspacesDir(home);
    const hold = holdingPathFor(home, id);
    const liveStat = lstatOrNull(resolved);
    const holdStat = lstatOrNull(hold);
    if (!liveStat) {
        if (holdStat) return { holdingPath: hold, adopted: true };
        return { holdingPath: null, adopted: false, note: 'it had no local data folder' };
    }
    if (holdStat) {
        throw new Error(`refusing to delete workspace "${entry.name}": a holding folder for its id already exists (${hold}) while its own folder is still in place — resolve this by hand`);
    }
    assertMovableDir(resolved, workspacesDir, entry.name);
    try {
        fs.renameSync(resolved, hold);
    } catch (err) {
        throw new Error(`refusing to delete workspace "${entry.name}": could not stage its directory for removal (${(err as Error).message})`);
    }
    return { holdingPath: hold, adopted: false };
}

/** Undo `holdWorkspaceDir` (restore, or a failed delete). Refuses to overwrite anything at the destination. */
export function releaseHold(holdingPath: string, originalPath: string, home: string): void {
    const hold = path.resolve(holdingPath);
    const dest = path.resolve(originalPath);
    if (!isUnderManagedDir(hold, home) || !path.basename(hold).startsWith(HOLD_PREFIX)) {
        throw new Error(`refusing to restore: ${hold} is not a holding folder under the managed workspaces folder`);
    }
    if (!isUnderManagedDir(dest, home)) throw new Error(`refusing to restore into ${dest}: it is outside the managed workspaces folder`);
    if (lstatOrNull(dest)) throw new Error(`cannot restore: ${dest} already exists`);
    assertMovableDir(hold, managedWorkspacesDir(home), path.basename(hold));
    fs.renameSync(hold, dest);
}

/* ─── tree measurement ─────────────────────────────────────────── */

export interface TreeStats {
    files: number;
    bytes: number;
    /** First directory found on a different device than the tree root, if any (recursive removal would cross it). */
    crossDevice: string | null;
}

export function treeStats(root: string): TreeStats {
    const out: TreeStats = { files: 0, bytes: 0, crossDevice: null };
    let rootDev: number;
    try { rootDev = fs.lstatSync(root).dev; } catch { return out; }
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const child = path.join(cur, e.name);
            try {
                const st = fs.lstatSync(child);
                if (st.isDirectory()) {
                    if (st.dev !== rootDev && !out.crossDevice) out.crossDevice = child;
                    stack.push(child);
                } else {
                    out.files += 1;
                    out.bytes += st.size;
                }
            } catch { /* vanished mid-walk */ }
        }
    }
    return out;
}

/* ─── the eraser ───────────────────────────────────────────────── */

export interface LocalDirEraserDeps {
    /** Lore home whose `workspaces/` folder holds the data. */
    home: string;
    /** Test seam: fault injection for the removal itself. Defaults to `fs.rmSync` recursive. */
    rm?: (p: string) => void;
}

const STORE = 'local-dir';

const step = (status: EraseStepResult['status'], detail?: string, removed: Record<string, number> = {}, remaining: Record<string, number> = {}): EraseStepResult =>
    ({ store: STORE, status, removed, remaining, ...(detail ? { detail } : {}) });

export function createLocalDirEraser(deps: LocalDirEraserDeps): WorkspaceEraser {
    const rm = deps.rm ?? ((p: string) => fs.rmSync(p, { recursive: true, force: true }));
    return {
        store: STORE,
        async erase(target: EraseTarget, _opts?: EraseOptions): Promise<EraseStepResult> {
            const home = deps.home;
            const hold = holdingPathFor(home, target.id);
            const recordedHold = target.holdingPath ? path.resolve(target.holdingPath) : null;
            if (recordedHold !== null && recordedHold !== hold) {
                return step('not-applicable', 'the recorded holding folder is not the one derived from this workspace id; nothing was removed');
            }
            // Never erase anything a live workspace still points at. A registry that cannot be read is not "empty".
            let live: WorkspaceEntry[];
            try { live = readLiveEntriesStrict(home); }
            catch (e) { return step('partial', `could not read the workspace registry, so nothing was removed (${(e as Error).message})`); }
            // A new-style delete (holdingPath recorded, even as null) only ever erases the id-derived holding folder, so
            // only that folder is checked: a NEW workspace that reuses the name sits at the old default path, and
            // matching on that path would wrongly skip the old held data. A legacy delete erases the old registered
            // path itself, so that path must not be live.
            const claimPaths = target.holdingPath === undefined ? [target.path, hold] : [hold];
            const claims = liveClaims(live, { id: target.id, name: target.name, paths: claimPaths });
            if (claims.byId || claims.byPath) {
                const detail = `a live workspace ("${(claims.byId ?? claims.byPath)!.name}") uses this id or folder; left untouched`;
                // Data still on disk that we refused to touch is never "not applicable": keep the receipt from reading complete.
                return lstatOrNull(hold) ? step('unverifiable', detail, {}, { entries: 1 }) : step('not-applicable', detail);
            }

            // Legacy delete (nothing held): move the old registered folder to the holding name first so a
            // partial removal can never be mistaken for a live path, then remove it.
            // `holdingPath === null` (explicit) means a new-style delete that held nothing: never touch the old path.
            if (recordedHold === null && target.holdingPath === undefined && !lstatOrNull(hold)) {
                const legacy = path.resolve(target.path);
                if (!target.path || !isUnderManagedDir(legacy, home)) {
                    return step('not-applicable', 'no local data folder inside the managed workspaces folder to erase');
                }
                if (!lstatOrNull(legacy)) return step('not-applicable', 'no local data folder was found');
                try {
                    assertMovableDir(legacy, managedWorkspacesDir(home), target.name);
                    fs.renameSync(legacy, hold);
                } catch (e) {
                    return step('partial', `could not stage the old folder for removal (${(e as Error).message})`);
                }
            }

            const holdStat = lstatOrNull(hold);
            if (!holdStat) {
                return recordedHold !== null ? step('complete', 'the holding folder was already gone') : step('not-applicable', 'no local data folder was found');
            }
            if (holdStat.isSymbolicLink() || !holdStat.isDirectory()) {
                return step('partial', 'the holding path is not a plain directory; nothing was removed', {}, { entries: 1 });
            }
            const parent = fs.statSync(managedWorkspacesDir(home));
            if (holdStat.dev !== parent.dev) {
                return step('partial', 'the holding folder is a mount point; nothing was removed', {}, { entries: 1 });
            }
            const before = treeStats(hold);
            if (before.crossDevice) {
                return step('partial', `a folder inside the data (${path.relative(hold, before.crossDevice)}) is on another filesystem; nothing was removed`, {}, { files: before.files });
            }
            try {
                rm(hold);
            } catch (e) {
                const after = treeStats(hold);
                return step('partial', `removal stopped early (${(e as Error).message}); it will be retried`,
                    { files: Math.max(0, before.files - after.files), bytes: Math.max(0, before.bytes - after.bytes) }, { files: after.files });
            }
            const left = lstatOrNull(hold);
            if (left) {
                const after = treeStats(hold);
                return step('partial', 'the holding folder is still present after removal; it will be retried',
                    { files: Math.max(0, before.files - after.files), bytes: Math.max(0, before.bytes - after.bytes) }, { files: after.files, entries: 1 });
            }
            return step('complete', undefined, { files: before.files, bytes: before.bytes }, { files: 0 });
        },
    };
}
