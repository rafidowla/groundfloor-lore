/**
 * workspaceErase/liveRegistry.ts — STRICT read of the live workspace registry for destructive code.
 *
 * The lenient loaders (`loadWorkspaces`) bootstrap or return an empty list when `workspaces.json` is absent
 * or unreadable, which would make "registry unreadable" look like "nothing is live". An eraser must read
 * that as "cannot prove this is unregistered" and refuse, so it uses this reader instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { liveWorkspaceIds } from '../../config/deletedWorkspaces.js';
import type { WorkspaceEntry } from '../../config/workspaces.js';

/** Throws when `workspaces.json` is absent, unreadable, not JSON, or lacks a usable non-empty `workspaces[]`. */
export function readLiveEntriesStrict(home: string): WorkspaceEntry[] {
    const file = path.join(home, 'workspaces.json');
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { throw new Error(`cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`${file} is not valid JSON`); }
    const list = (parsed as { workspaces?: unknown } | null)?.workspaces;
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${file} has no workspaces[]`);
    for (const w of list) {
        const e = w as { name?: unknown; path?: unknown } | null;
        if (!e || typeof e !== 'object' || typeof e.name !== 'string' || typeof e.path !== 'string') throw new Error(`${file} has a malformed workspace entry`);
    }
    return list as WorkspaceEntry[];
}

export interface LiveClaim {
    /** A live entry (any name) has this permanent id (stored, or derivable for an id-less entry). */
    byId: WorkspaceEntry | null;
    /** A live entry points at this path (resolved comparison). */
    byPath: WorkspaceEntry | null;
    /** A live entry carries this name. */
    byName: WorkspaceEntry | null;
}

/** What, if anything, the live registry claims for a deleted workspace's id / paths / name. */
export function liveClaims(entries: readonly WorkspaceEntry[], t: { id: string; name: string; paths: readonly string[] }): LiveClaim {
    const resolved = new Set(t.paths.filter((p) => p !== '').map((p) => path.resolve(p)));
    let byId: WorkspaceEntry | null = null;
    let byPath: WorkspaceEntry | null = null;
    let byName: WorkspaceEntry | null = null;
    for (const w of entries) {
        if (!byId && liveWorkspaceIds([w]).has(t.id)) byId = w;
        if (!byPath && typeof w.path === 'string' && resolved.has(path.resolve(w.path))) byPath = w;
        if (!byName && w.name === t.name) byName = w;
    }
    return { byId, byPath, byName };
}
