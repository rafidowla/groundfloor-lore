/**
 * deletedWorkspaces.ts — durable record of deliberately deleted workspaces (cloud purge, slice 1).
 *
 * Why:
 *   `deleteWorkspace` only drops the registry entry. In cloud / local-sync mode the workspace's rows
 *   stay in Dataplane under its PERMANENT id (config/workspaceIds.ts), and nothing remembers that id
 *   once the entry is gone. A purge tool that scans Dataplane and subtracts the registry cannot tell
 *   "deleted on purpose" from "registry unreadable / entry lost", so it would delete live data. This
 *   log is the allow-list: only ids written here, BEFORE the registry entry was removed, may be purged.
 *
 * File: `<lore home>/workspace-deletions.jsonl` (beside workspaces.json), append-only JSON lines.
 *   Append-only because the daemon (deletions) and the purge CLI (purge events) both write: no
 *   read-modify-write, no lost update. An unparsable or torn line is skipped on read, which can only
 *   make an id "unrecorded" — the safe direction for a destructive tool.
 *
 *   {"v":1,"event":"deleted","id","idSource":"stored"|"derived","name","path","createdAt","deletedAt","orgId","mode"}
 *   {"v":1,"event":"purge","id","at","connection","status":"partial"|"complete"|"unverifiable","collections":{...}}
 *
 * Rules:
 *   - Aliases: no record when another REMAINING entry still keeps the data live (same id, or — for an
 *     id-less entry — same path, or an id-less sibling that would inherit this id on backfill).
 *   - Id-less (legacy, never backfilled) entries record `deriveWorkspaceId(path, createdAt)` as "derived".
 *   - A failed append throws; `deleteWorkspace` calls this before touching the registry.
 *   - `name` / `path` are informational and never used for matching.
 *
 * Import note: `workspaces.ts` is imported as TYPES only. workspaceIds.ts imports workspaces.ts, and
 * workspaces.ts imports this module, so there is a runtime import cycle through workspaceIds.ts; it is
 * benign (every cross-module use is inside a function body, none at module evaluation).
 */

import fs from 'fs';
import path from 'path';
import { DEFAULT_CONFIG, resolveDeploymentMode } from './configManager.js';
import { deriveWorkspaceId } from './workspaceIds.js';
import type { WorkspaceEntry } from './workspaces.js';

export const DELETION_LOG_FILE = 'workspace-deletions.jsonl';

export interface DeletionRecord {
    v: 1;
    event: 'deleted';
    id: string;
    idSource: 'stored' | 'derived';
    name: string;
    path: string;
    createdAt: string | null;
    deletedAt: string;
    orgId: string | null;
    /** Deployment mode from env/default (`LORE_DEPLOYMENT_MODE`, else 'local'); per-workspace config is not read. */
    mode: string | null;
}

export type PurgeStatus = 'partial' | 'complete' | 'unverifiable';

export interface PurgeEvent {
    v: 1;
    event: 'purge';
    id: string;
    at: string;
    connection: string;
    status: PurgeStatus;
    collections: Record<string, unknown>;
}

export interface DeletionState {
    /** Latest deletion record for this id (file order), if any. */
    deletion?: DeletionRecord;
    /** Latest purge event for this id (file order), if any. */
    lastPurge?: PurgeEvent;
}

export interface DeletionLog {
    byId: Map<string, DeletionState>;
    /** Lines that were blank-free but unparsable, torn, or of an unknown shape/version. */
    skippedLines: number;
}

export function deletionLogPath(home: string): string {
    return path.join(home, DELETION_LOG_FILE);
}

/** An id is MISSING only when absent/null/empty (same rule as workspaceIds.ts). */
const hasStoredId = (w: Pick<WorkspaceEntry, 'id'>): w is { id: string } =>
    typeof w.id === 'string' && w.id !== '';

/**
 * Every id that is LIVE in `entries`: each entry's stored id, plus, for id-less entries, both
 * derivations a backfill could produce (path + createdAt, and path alone). Computed in memory only —
 * nothing is written, so a purge can ask "is this id live?" without running `ensureWorkspaceIds`.
 */
export function liveWorkspaceIds(entries: readonly WorkspaceEntry[]): Set<string> {
    const live = new Set<string>();
    for (const w of entries) {
        if (hasStoredId(w)) {
            live.add(w.id);
            continue;
        }
        if (typeof w.createdAt === 'string' && w.createdAt !== '') live.add(deriveWorkspaceId(w.path, w.createdAt));
        live.add(deriveWorkspaceId(w.path));
    }
    return live;
}

/** Append one JSON line, creating the home if needed and fsyncing. Starts a fresh line after a torn tail. */
function appendLine(home: string, obj: DeletionRecord | PurgeEvent): void {
    fs.mkdirSync(home, { recursive: true });
    const fd = fs.openSync(deletionLogPath(home), 'a+');
    try {
        const size = fs.fstatSync(fd).size;
        let prefix = '';
        if (size > 0) {
            const last = Buffer.alloc(1);
            fs.readSync(fd, last, 0, 1, size - 1);
            if (last[0] !== 0x0a) prefix = '\n';
        }
        fs.writeSync(fd, `${prefix}${JSON.stringify(obj)}\n`);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Record that `entry` is being deleted. `remaining` is the registry AFTER the removal. Returns the
 * record written, or null when another remaining entry keeps the same data live (alias). Throws when
 * the append fails — the caller must not change the registry in that case.
 */
export function recordWorkspaceDeletion(
    entry: WorkspaceEntry,
    remaining: readonly WorkspaceEntry[],
    home: string,
    now: Date = new Date(),
): DeletionRecord | null {
    const stored = hasStoredId(entry);
    if (stored) {
        // Same id elsewhere (alias), or an id-less same-path sibling that would inherit it on backfill.
        if (remaining.some((o) => (hasStoredId(o) ? o.id === entry.id : o.path === entry.path))) return null;
    } else if (remaining.some((o) => o.path === entry.path)) {
        return null;
    }
    const createdAt = typeof entry.createdAt === 'string' && entry.createdAt !== '' ? entry.createdAt : null;
    const rec: DeletionRecord = {
        v: 1,
        event: 'deleted',
        id: stored ? entry.id : deriveWorkspaceId(entry.path, createdAt ?? undefined),
        idSource: stored ? 'stored' : 'derived',
        name: entry.name,
        path: entry.path,
        createdAt,
        deletedAt: now.toISOString(),
        orgId: process.env['DATAPLANE_ORG_ID'] || null,
        mode: resolveDeploymentMode(DEFAULT_CONFIG),
    };
    appendLine(home, rec);
    return rec;
}

/** Append a purge event (written by the purge CLI). Throws on failure. */
export function appendPurgeEvent(
    ev: Omit<PurgeEvent, 'v' | 'event' | 'at'> & { at?: string },
    home: string,
): PurgeEvent {
    const full: PurgeEvent = { v: 1, event: 'purge', at: new Date().toISOString(), ...ev };
    appendLine(home, full);
    return full;
}

/** Parse the log into per-id state. A missing file is an empty log; bad lines are skipped and counted. */
export function readDeletionLog(home: string): DeletionLog {
    const byId = new Map<string, DeletionState>();
    let skippedLines = 0;
    let text: string;
    try {
        text = fs.readFileSync(deletionLogPath(home), 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { byId, skippedLines };
        throw err;
    }
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let o: unknown;
        try {
            o = JSON.parse(line);
        } catch {
            skippedLines++;
            continue;
        }
        const r = o as { v?: unknown; event?: unknown; id?: unknown } | null;
        if (!r || typeof r !== 'object' || r.v !== 1 || typeof r.id !== 'string' || r.id === '') {
            skippedLines++;
            continue;
        }
        const state = byId.get(r.id) ?? {};
        if (r.event === 'deleted') state.deletion = r as unknown as DeletionRecord;
        else if (r.event === 'purge') state.lastPurge = r as unknown as PurgeEvent;
        else {
            skippedLines++;
            continue;
        }
        byId.set(r.id, state);
    }
    return { byId, skippedLines };
}
