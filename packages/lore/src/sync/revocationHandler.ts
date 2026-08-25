/**
 * revocationHandler.ts — Execute workspace-removal decisions safely.
 *
 * The reconciler decides WHAT to drop. This module is the executor:
 * given a list of workspace ids to remove, it does the disk work
 * with safety rails so a buggy reconciler / bad input can't wipe
 * the wrong directory.
 *
 * Safety layers:
 *
 *   1. Path containment — every target dir is resolved + checked to
 *      be a descendant of LORE_HOME/workspaces. Anything that
 *      resolves elsewhere (path traversal, absolute paths in the
 *      workspaceId) is refused.
 *
 *   2. Active-workspace guard — refuses to drop the workspace the
 *      operator is currently using (its data is actively read by
 *      the daemon; nuking it would crash the process).
 *
 *   3. Never-drop allowlist — caller-supplied ids that must NEVER
 *      be removed even when cloud says they should. Mirrors the
 *      `neverDrop` knob on `reconcile()`; pass the SAME allowlist
 *      to both so the two layers are consistent.
 *
 *   4. Pre-flight existence check — non-existent dirs are silently
 *      skipped (counted as "already gone").
 *
 *   5. Audit trail — every action (executed, skipped, refused)
 *      is captured in the returned report. Caller writes to the
 *      daemon's existing audit log.
 *
 *   6. Recursive remove is the LAST step + uses `rmSync({recursive,
 *      force})` — no shell, no follow-symlinks.
 *
 * The actual filesystem call is injectable so tests can verify the
 * safety logic without touching real disk.
 */

import fs from 'node:fs';
import path from 'node:path';

export type RevokeOutcome =
    | { kind: 'executed';   workspaceId: string }
    | { kind: 'skipped';    workspaceId: string; reason: 'not-on-disk' | 'is-active' | 'in-never-drop' | 'path-escape' }
    | { kind: 'failed';     workspaceId: string; reason: string };

export interface RevokeWorkspaceInput {
    /** Workspace ids the reconciler marked for drop. */
    workspaceIds: ReadonlyArray<string>;
    /** Absolute path of the workspaces root, e.g. `<LORE_HOME>/workspaces`. */
    workspacesRoot: string;
    /** Currently-active workspace id; never dropped. May be null when there is no active workspace. */
    activeWorkspaceId: string | null;
    /** Ids the caller wants to protect from drop. Mirror of `neverDrop` on reconcile(). */
    neverDrop?: ReadonlyArray<string>;
    /** Injectable fs.rmSync for tests. Defaults to the real one. */
    rmSyncImpl?: (target: string, opts: { recursive?: boolean; force?: boolean }) => void;
    /** Injectable existsSync for tests. */
    existsSyncImpl?: (target: string) => boolean;
}

export interface RevokeReport {
    executed: string[];
    skipped: Array<{ workspaceId: string; reason: 'not-on-disk' | 'is-active' | 'in-never-drop' | 'path-escape' }>;
    failed: Array<{ workspaceId: string; reason: string }>;
    /** All outcomes in input order — useful for audit log. */
    all: RevokeOutcome[];
}

export function revokeWorkspaces(input: RevokeWorkspaceInput): RevokeReport {
    const root = path.resolve(input.workspacesRoot);
    const protect = new Set(input.neverDrop ?? []);
    const exists = input.existsSyncImpl ?? fs.existsSync;
    const rm = input.rmSyncImpl ?? fs.rmSync;

    const report: RevokeReport = { executed: [], skipped: [], failed: [], all: [] };

    for (const workspaceId of input.workspaceIds) {
        const outcome = revokeOne(workspaceId, root, input.activeWorkspaceId, protect, exists, rm);
        report.all.push(outcome);
        switch (outcome.kind) {
            case 'executed': report.executed.push(outcome.workspaceId); break;
            case 'skipped':  report.skipped.push({ workspaceId: outcome.workspaceId, reason: outcome.reason }); break;
            case 'failed':   report.failed.push({ workspaceId: outcome.workspaceId, reason: outcome.reason }); break;
        }
    }
    return report;
}

function revokeOne(
    workspaceId: string,
    workspacesRoot: string,
    activeWorkspaceId: string | null,
    neverDrop: Set<string>,
    exists: (target: string) => boolean,
    rm: (target: string, opts: { recursive?: boolean; force?: boolean }) => void,
): RevokeOutcome {
    // Layer 2: never drop the active workspace.
    if (activeWorkspaceId && workspaceId === activeWorkspaceId) {
        return { kind: 'skipped', workspaceId, reason: 'is-active' };
    }
    // Layer 3: never drop allowlisted ids.
    if (neverDrop.has(workspaceId)) {
        return { kind: 'skipped', workspaceId, reason: 'in-never-drop' };
    }
    // Layer 1: path containment. Resolve the target + verify it
    // descends from workspacesRoot. Rejects path traversal,
    // absolute paths, '..' segments, etc.
    const target = path.resolve(workspacesRoot, workspaceId);
    const safe = withinRoot(target, workspacesRoot);
    if (!safe) {
        return { kind: 'skipped', workspaceId, reason: 'path-escape' };
    }
    // Layer 4: existence check. Already gone → no-op.
    if (!exists(target)) {
        return { kind: 'skipped', workspaceId, reason: 'not-on-disk' };
    }
    // Layer 6: rmSync recursive + force, no shell, no symlink follow.
    try {
        rm(target, { recursive: true, force: true });
        return { kind: 'executed', workspaceId };
    } catch (e) {
        return { kind: 'failed', workspaceId, reason: (e as Error).message };
    }
}

/**
 * True if `target` is a descendant of `root` (or equal to it — we
 * still reject that case in the caller because workspace ids can't
 * be empty). Uses path resolution + prefix check; resilient to
 * relative `..` segments and absolute-path workspaceIds.
 */
export function withinRoot(target: string, root: string): boolean {
    const rel = path.relative(root, target);
    if (rel === '') return false;             // refuse to operate on root itself
    if (rel.startsWith('..')) return false;
    if (path.isAbsolute(rel)) return false;
    return true;
}
