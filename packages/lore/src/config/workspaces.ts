/**
 * workspaces.ts — Multi-workspace registry for Lore V2.1.
 *
 * Model:
 *   Each workspace is a completely separate Kùzu graph + LanceDB verbatim
 *   store + .lore/config.json. Switching workspaces is a hard context
 *   switch — like Slack teams or Claude app accounts. Graphs never
 *   cross-query; plugins listed in one workspace's config are invisible
 *   to another.
 *
 * On-disk layout:
 *   ~/.groundfloor/
 *     workspaces.json                 ← this module's control file
 *     .lore/…                         ← legacy V2 path, promoted to "default"
 *     workspaces/
 *       family/.lore/…                ← new workspaces live here
 *       personal/.lore/…
 *
 * Control file shape:
 *   {
 *     active: "default",
 *     workspaces: [
 *       { name: "default", path: "/Users/foo/.groundfloor",           createdAt: "..." },
 *       { name: "family",  path: "/Users/foo/.groundfloor/workspaces/family", createdAt: "..." }
 *     ]
 *   }
 *
 * Migration:
 *   If workspaces.json doesn't exist but ~/.groundfloor/.lore/graph does
 *   (i.e. a V2.0 install), we auto-write workspaces.json with a single
 *   "default" workspace pointing at that existing path — no data moves,
 *   no data loss.
 *
 * Thread safety:
 *   Synchronous disk ops, single writer. HTTP handlers serialize via
 *   Node's event loop. Concurrent switches are idempotent — last write
 *   wins and is what the next boot picks up.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { loreHome, loreHomePath } from './loreHome.js';

/**
 * Per-workspace retention policy (2026-04-28). Soft-supersession is the
 * mechanism; this is the policy on top.
 *
 * - hideSupersededInRecall: when true (default), recall + search results
 *     drop nodes whose supersededAt is non-null. Off lets stale decisions
 *     compete against current ones in semantic results.
 * - hideSupersededInGraph: when true, the network view hides superseded
 *     nodes server-side regardless of the per-session "Show superseded"
 *     toggle. Default false — UI toggle is the authoritative control.
 * - autoArchiveSupersededAfterDays: when a positive integer, a daily
 *     sweep tombstones the verbatim row (preserves the graph node + its
 *     edges) for any superseded node older than this threshold. null /
 *     0 disables the sweep. Reversible via the verbatim history endpoint
 *     since tombstone snapshots the content.
 */
export interface WorkspaceRetentionPolicy {
    hideSupersededInRecall?: boolean;
    hideSupersededInGraph?: boolean;
    autoArchiveSupersededAfterDays?: number | null;
}

export interface WorkspaceEntry {
    name: string;
    path: string;
    createdAt: string;
    retention?: WorkspaceRetentionPolicy;
}

export interface WorkspacesFile {
    active: string;
    workspaces: WorkspaceEntry[];
}

const HOME_GROUNDFLOOR = loreHome();
const CONTROL_FILE = path.join(HOME_GROUNDFLOOR, 'workspaces.json');
const WORKSPACES_DIR = path.join(HOME_GROUNDFLOOR, 'workspaces');

/**
 * kebabCase — Normalize a user-entered workspace name to a safe on-disk id.
 * Rules: lowercase, alnum + dash, 1–40 chars. Empty / invalid → throws.
 */
export function kebabCase(name: string): string {
    const kebab = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!kebab || kebab.length > 40) {
        throw new Error(`Invalid workspace name "${name}". Use 1–40 letters/digits/dashes.`);
    }
    return kebab;
}

/** Load workspaces.json, running the V2.0 → V2.1 migration if needed. */
export function loadWorkspaces(): WorkspacesFile {
    if (fs.existsSync(CONTROL_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8')) as WorkspacesFile;
        if (!parsed.active || !Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) {
            throw new Error(`Corrupt ${CONTROL_FILE}: missing active or workspaces[]`);
        }
        return parsed;
    }

    // First-run migration: adopt the existing ~/.groundfloor/.lore if it
    // exists, otherwise create an empty "default" workspace.
    const legacyLore = path.join(HOME_GROUNDFLOOR, '.lore');
    const hasLegacy = fs.existsSync(legacyLore);
    if (!hasLegacy && !fs.existsSync(HOME_GROUNDFLOOR)) {
        fs.mkdirSync(HOME_GROUNDFLOOR, { recursive: true });
    }
    const file: WorkspacesFile = {
        active: 'default',
        workspaces: [
            {
                name: 'default',
                path: HOME_GROUNDFLOOR,
                createdAt: new Date().toISOString(),
            },
        ],
    };
    fs.writeFileSync(CONTROL_FILE, JSON.stringify(file, null, 2), 'utf8');
    return file;
}

/** Returns the disk path for the currently-active workspace. */
export function getActiveWorkspacePath(): string {
    const f = loadWorkspaces();
    const entry = f.workspaces.find((w) => w.name === f.active);
    if (!entry) {
        throw new Error(`workspaces.json.active="${f.active}" has no matching entry`);
    }
    return entry.path;
}

export function getActiveWorkspaceName(): string {
    return loadWorkspaces().active;
}

/**
 * createWorkspace — Register a new workspace and create its .lore/ dir.
 * Does NOT switch to it; call switchWorkspace() afterwards to activate.
 */
export function createWorkspace(rawName: string): WorkspaceEntry {
    const name = kebabCase(rawName);
    const file = loadWorkspaces();
    if (file.workspaces.some((w) => w.name === name)) {
        throw new Error(`Workspace "${name}" already exists`);
    }
    const workspacePath = path.join(WORKSPACES_DIR, name);
    const loreDir = path.join(workspacePath, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    const entry: WorkspaceEntry = {
        name,
        path: workspacePath,
        createdAt: new Date().toISOString(),
    };
    file.workspaces.push(entry);
    writeControl(file);
    return entry;
}

/**
 * switchWorkspace — Change the active workspace. Returns the new state.
 * Caller is responsible for restarting the daemon so the graph can be
 * re-initialized against the new path.
 */
export function switchWorkspace(name: string): WorkspacesFile {
    const file = loadWorkspaces();
    if (!file.workspaces.some((w) => w.name === name)) {
        throw new Error(`Unknown workspace "${name}"`);
    }
    file.active = name;
    writeControl(file);
    return file;
}

/**
 * deleteWorkspace — Remove a workspace from the registry. Does NOT touch
 * its on-disk data — user must rm -rf manually to irrevocably lose data.
 * Cannot delete the legacy/bootstrap workspace (the one anchored at
 * HOME_GROUNDFLOOR rather than under workspaces/) or the active one.
 */
export function deleteWorkspace(name: string): WorkspacesFile {
    const file = loadWorkspaces();
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    if (entry.path === HOME_GROUNDFLOOR) {
        throw new Error('Cannot delete the legacy/bootstrap workspace (path is the Lore home)');
    }
    if (file.active === name) throw new Error('Cannot delete the active workspace');
    file.workspaces = file.workspaces.filter((w) => w.name !== name);
    writeControl(file);
    return file;
}

/**
 * renameWorkspace — Change a workspace's name without moving its data on
 * disk. The path stays put; only the label/identity changes. Use this to
 * give workspaces meaningful names ("default" → "developer") after the
 * fact.
 *
 * Updates `active` if the renamed workspace was active. Rejects collisions
 * with existing names. The legacy "default" entry is renameable — its
 * path stays anchored at HOME_GROUNDFLOOR; only the label moves.
 */
export function renameWorkspace(oldName: string, rawNewName: string): WorkspacesFile {
    const newName = kebabCase(rawNewName);
    if (oldName === newName) return loadWorkspaces();
    const file = loadWorkspaces();
    if (!file.workspaces.some((w) => w.name === oldName)) {
        throw new Error(`Unknown workspace "${oldName}"`);
    }
    if (file.workspaces.some((w) => w.name === newName)) {
        throw new Error(`Workspace "${newName}" already exists`);
    }
    file.workspaces = file.workspaces.map((w) =>
        w.name === oldName ? { ...w, name: newName } : w,
    );
    if (file.active === oldName) file.active = newName;
    writeControl(file);
    return file;
}

function writeControl(file: WorkspacesFile): void {
    fs.writeFileSync(CONTROL_FILE, JSON.stringify(file, null, 2), 'utf8');
}

/**
 * Read the retention policy for a workspace by name. Falls back to
 * sensible defaults when the workspace has no `retention` block (older
 * workspaces.json files predate the field).
 */
export function getWorkspaceRetention(name: string): WorkspaceRetentionPolicy {
    const file = loadWorkspaces();
    const entry = file.workspaces.find((w) => w.name === name);
    return {
        hideSupersededInRecall: entry?.retention?.hideSupersededInRecall ?? true,
        hideSupersededInGraph: entry?.retention?.hideSupersededInGraph ?? false,
        autoArchiveSupersededAfterDays: entry?.retention?.autoArchiveSupersededAfterDays ?? null,
    };
}

/**
 * Update the retention policy for a workspace by name. Merges with any
 * existing block — partial updates allowed (e.g. just toggle one field).
 */
export function setWorkspaceRetention(name: string, patch: Partial<WorkspaceRetentionPolicy>): WorkspaceRetentionPolicy {
    const file = loadWorkspaces();
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    const current = entry.retention ?? {};
    const merged: WorkspaceRetentionPolicy = { ...current, ...patch };
    entry.retention = merged;
    writeControl(file);
    return merged;
}
