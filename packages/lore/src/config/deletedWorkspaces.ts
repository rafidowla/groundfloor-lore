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
 *   {"v":1,"event":"deleted","id","idSource":"stored"|"derived","name","path","createdAt","deletedAt","orgId","mode"
 *       [,"eraseAfter","windowDays","holdingPath"]}                      (lane f6b fields are additive; absent = legacy delete)
 *   {"v":1,"event":"purge","id","at","connection","status":"partial"|"complete"|"unverifiable","collections":{...}}
 *   {"v":1,"event":"erased","id","at","status":"complete"|"partial"|"needs-operator","stores":[EraseStepResult...]
 *       [,"unverifiableStreak"]}                                    (lane f6b receipt; streak = consecutive all-unverifiable attempts, absent = 0)
 *   {"v":1,"event":"erase-failed","id","at","attempt","error"}                                          (lane f6b, no secrets)
 *   {"v":1,"event":"restored","id","at","name"}                                                          (lane f6b)
 *
 * Cycles: a workspace can be deleted, restored and deleted again. A `deleted` record starts a new cycle, so
 * `erased` / `erase-failed` / `restored` apply to the LATEST `deleted` record of their id (file order); the
 * per-cycle fields of `DeletionState` reset when a new `deleted` record is read. `lastPurge` is not per cycle.
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
import type { EraseStepResult } from '../engines/workspaceErase/types.js';

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
    /** Lane f6b (additive) — ISO time after which Lore erases everything it controls. Absent = legacy delete (kept, never auto-erased). */
    eraseAfter?: string;
    /** Lane f6b (additive) — the recovery window that was in force, in days (informational). */
    windowDays?: number;
    /** Lane f6b (additive) — hidden holding folder the data dir was renamed to (null/absent = nothing was held). */
    holdingPath?: string | null;
    /**
     * Lane f6b (additive) — full registry entry as it was at delete time, so `lore workspaces restore` can put
     * it back exactly (engine choice, mode, template, label). Absent on legacy records (those cannot be restored).
     */
    entry?: WorkspaceEntry;
}

/**
 * `needs-operator` (additive): the erase was retried and every remaining non-complete step stayed `unverifiable` for the
 * configured number of consecutive attempts (`LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS`). Terminal for the scheduled
 * tick; `erase-now` still retries it.
 */
export type EraseOverallStatus = 'complete' | 'partial' | 'needs-operator';

/** Lane f6b — receipt of one erase run. `stores` is the per-store result list, in run order. */
export interface ErasedEvent {
    v: 1;
    event: 'erased';
    id: string;
    at: string;
    status: EraseOverallStatus;
    stores: EraseStepResult[];
    /**
     * Additive — consecutive attempts (including this one) in which every non-complete step was `unverifiable` and none
     * was `partial`. Absent = 0 (receipts written before this field existed). Reaching the limit makes the status `needs-operator`.
     */
    unverifiableStreak?: number;
}

/** Lane f6b — one failed/partial erase attempt (drives retry backoff). `error` never contains secrets. */
export interface EraseFailedEvent {
    v: 1;
    event: 'erase-failed';
    id: string;
    at: string;
    attempt: number;
    error: string;
}

/** Lane f6b — the deletion was undone inside the window. */
export interface RestoredEvent {
    v: 1;
    event: 'restored';
    id: string;
    at: string;
    /** Name the workspace was (or is being) restored under. */
    name: string;
    /** Registered data path it is restored to (additive; lets an interrupted restore be finished). */
    path?: string;
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
    /** Lane f6b, this cycle — the latest `erased` receipt (any status), if any. */
    lastErased?: ErasedEvent;
    /** This cycle — the latest `erased` receipt when it is `needs-operator` (cleared by any later receipt or failure). */
    needsOperator?: ErasedEvent;
    /** This cycle — current consecutive all-`unverifiable` attempt count, from the latest receipt (0 after a failure or a real `partial`). */
    unverifiableStreak: number;
    /** Lane f6b, this cycle — the first `erased` receipt with status `complete`, if any. */
    completedErase?: ErasedEvent;
    /** Lane f6b, this cycle — number of `erase-failed` events (the retry attempt counter). */
    failedAttempts: number;
    /** Erase attempts this cycle that did not finish: `erase-failed` events plus `erased` events with status partial. Drives retry backoff. */
    attempts: number;
    /** Lane f6b, this cycle — the latest `erase-failed` event, if any. */
    lastFailure?: EraseFailedEvent;
    /** Lane f6b, this cycle — the `restored` event, if the deletion was undone (and not deleted again since). */
    restored?: RestoredEvent;
    /** Lane f6b, this cycle — true once any erase work may have started (a receipt, a failure, or a purge event after the delete). */
    eraseStarted: boolean;
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

type LogEvent = DeletionRecord | PurgeEvent | ErasedEvent | EraseFailedEvent | RestoredEvent;

/** Append one JSON line, creating the home if needed and fsyncing. Starts a fresh line after a torn tail. */
function appendLine(home: string, obj: LogEvent): void {
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
    erase?: { eraseAfter: string; windowDays: number; holdingPath: string | null },
): DeletionRecord | null {
    const stored = hasStoredId(entry);
    if (deletionKeepsDataLive(entry, remaining)) return null;
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
        ...(erase ? { eraseAfter: erase.eraseAfter, windowDays: erase.windowDays, holdingPath: erase.holdingPath, entry: { ...entry } } : {}),
    };
    appendLine(home, rec);
    return rec;
}

/**
 * True when another REMAINING entry keeps `entry`'s data live (same stored id, or — for an id-less entry /
 * an id-less sibling — the same path). Such a delete records nothing and must never move or erase the data.
 */
export function deletionKeepsDataLive(entry: WorkspaceEntry, remaining: readonly WorkspaceEntry[]): boolean {
    if (hasStoredId(entry)) {
        // Same id elsewhere (alias), or an id-less same-path sibling that would inherit it on backfill.
        return remaining.some((o) => (hasStoredId(o) ? o.id === entry.id : o.path === entry.path));
    }
    return remaining.some((o) => o.path === entry.path);
}

/** The permanent id a deletion of `entry` records (stored, else derived like a backfill would). */
export function deletionIdOf(entry: WorkspaceEntry): string {
    if (hasStoredId(entry)) return entry.id;
    const createdAt = typeof entry.createdAt === 'string' && entry.createdAt !== '' ? entry.createdAt : null;
    return deriveWorkspaceId(entry.path, createdAt ?? undefined);
}

/** Append an `erased` receipt (lane f6b). Throws on failure. */
export function appendErasedEvent(ev: { id: string; status: EraseOverallStatus; stores: EraseStepResult[]; at?: string; unverifiableStreak?: number }, home: string): ErasedEvent {
    const full: ErasedEvent = { v: 1, event: 'erased', id: ev.id, at: ev.at ?? new Date().toISOString(), status: ev.status, stores: ev.stores,
        ...(ev.unverifiableStreak ? { unverifiableStreak: ev.unverifiableStreak } : {}) };
    appendLine(home, full);
    return full;
}

/** Append an `erase-failed` event (lane f6b). `error` must already be free of secrets. Throws on failure. */
export function appendEraseFailedEvent(ev: { id: string; attempt: number; error: string; at?: string }, home: string): EraseFailedEvent {
    const full: EraseFailedEvent = { v: 1, event: 'erase-failed', id: ev.id, at: ev.at ?? new Date().toISOString(), attempt: ev.attempt, error: ev.error };
    appendLine(home, full);
    return full;
}

/** Append a `restored` event (lane f6b). Throws on failure. */
export function appendRestoredEvent(ev: { id: string; name: string; path?: string; at?: string }, home: string): RestoredEvent {
    const full: RestoredEvent = { v: 1, event: 'restored', id: ev.id, at: ev.at ?? new Date().toISOString(), name: ev.name, ...(ev.path ? { path: ev.path } : {}) };
    appendLine(home, full);
    return full;
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
        const state: DeletionState = byId.get(r.id) ?? { failedAttempts: 0, attempts: 0, unverifiableStreak: 0, eraseStarted: false };
        if (r.event === 'deleted') {
            // A new `deleted` record starts a new cycle (delete -> restore -> delete again).
            state.deletion = r as unknown as DeletionRecord;
            delete state.lastErased;
            delete state.completedErase;
            delete state.lastFailure;
            delete state.restored;
            delete state.needsOperator;
            state.unverifiableStreak = 0;
            state.failedAttempts = 0;
            state.attempts = 0;
            state.eraseStarted = false;
        } else if (r.event === 'purge') {
            state.lastPurge = r as unknown as PurgeEvent;
            const at = Date.parse((r as { at?: unknown }).at as string);
            const delAt = state.deletion ? Date.parse(state.deletion.deletedAt) : NaN;
            if (state.deletion && Number.isFinite(at) && Number.isFinite(delAt) && at >= delAt) state.eraseStarted = true;
        } else if (r.event === 'erased') {
            const ev = r as unknown as ErasedEvent;
            if ((ev.status !== 'complete' && ev.status !== 'partial' && ev.status !== 'needs-operator') || !Array.isArray(ev.stores)) { skippedLines++; continue; }
            state.lastErased = ev;
            if (ev.status === 'partial' || ev.status === 'needs-operator') state.attempts += 1;
            // A receipt without the counter (older versions) counts as 0, so old logs load unchanged.
            state.unverifiableStreak = Number.isSafeInteger(ev.unverifiableStreak) && (ev.unverifiableStreak as number) > 0 ? (ev.unverifiableStreak as number) : 0;
            if (ev.status === 'needs-operator') state.needsOperator = ev; else delete state.needsOperator;
            if (ev.status === 'complete' && !state.completedErase) state.completedErase = ev;
            state.eraseStarted = true;
        } else if (r.event === 'erase-failed') {
            state.lastFailure = r as unknown as EraseFailedEvent;
            state.failedAttempts += 1;
            state.attempts += 1;
            state.unverifiableStreak = 0; // a real failure breaks "consecutive unverifiable"
            delete state.needsOperator;
            state.eraseStarted = true;
        } else if (r.event === 'restored') {
            state.restored = r as unknown as RestoredEvent;
        } else {
            skippedLines++;
            continue;
        }
        byId.set(r.id, state);
    }
    return { byId, skippedLines };
}
