/**
 * workspaceIds.ts — the permanent Lore-workspace id (cloud parity C review #6, Rafi 2026-10-01).
 *
 * Why:
 *   Cloud (Dataplane) rows used to be keyed and filtered by the workspace NAME, so a rename orphaned
 *   the data, delete-then-recreate re-attached the old rows and aliases were not honoured. Each
 *   registry entry now carries an immutable `id`; cloud rows use it (`lore_workspace` column, the D2
 *   row key, every scope filter). Callers and apps keep using names: name -> id happens once, at the
 *   scope boundary (`resolveDataplaneScope` via the registry view's `resolveId`).
 *
 * Where ids come from:
 *   - createWorkspace() / a fresh home's default entry: `randomUUID()` (workspaces.ts). Rename keeps
 *     it; delete-then-recreate gets a NEW one, so the old rows stay unreachable.
 *   - registerWorkspaceAlias(): copies the id of the entry that owns the same path.
 *   - Entries written before this field existed carry no id. `ensureWorkspaceIds` backfills them, and
 *     is called ONLY when a Dataplane-backed store is built and asks for an id (cloud mode or
 *     local-sync mode — see `createWorkspaceRegistry`). Local and embedded hosts never call it, so
 *     their workspaces.json is never rewritten just because Lore booted.
 *
 * Backfill rules:
 *   - Deterministic: the id is derived from the entry's PATH plus its `createdAt` (not the name).
 *     Entries that share a path (an alias and its target) share one id because a missing id is copied
 *     from a same-path sibling first, and two processes backfilling concurrently compute the very same
 *     ids — they converge by construction.
 *   - Salted with `createdAt` (adversarial isolation review, 2026-10-01): a path-only derivation gave a
 *     deleted legacy workspace and a later id-less entry at the same path (an older build's
 *     delete-then-recreate, or `registerWorkspaceAlias` onto a deleted workspace's leftover
 *     directory) the SAME id, so the new entry inherited the deleted one's cloud rows. Every build
 *     writes `createdAt` on create / alias / default, and a re-creation gets a new timestamp, so the
 *     ids differ. An entry with no `createdAt` falls back to the path alone. The result is still re-read from disk after
 *     the atomic write and the on-disk value is what callers adopt.
 *   - Atomic and minimal: only entries missing an id change; every other field (path fields
 *     included — workspaces.json path fields override LORE_HOME) is preserved verbatim, via
 *     `writeControl`'s tmp-file + rename.
 *   - Never creates the file (an absent registry serves nothing) and never replaces an id that is
 *     present, even a malformed one (that fails closed instead of being silently re-keyed).
 *   - There is no data migration: nothing was deployed in cloud under name-keyed rows.
 */

import { createHash } from 'node:crypto';
import { loadWorkspacesIfPresent, writeControl, type WorkspaceEntry, type WorkspacesFile } from './workspaces.js';

/** A usable id: printable, no separators / control characters (the row-key preimage joins parts with U+001F). */
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidWorkspaceId(v: unknown): v is string {
    return typeof v === 'string' && VALID_ID.test(v);
}

/**
 * UUID-shaped, deterministic id for a legacy entry, derived from its path and creation time. The
 * creation time keeps a re-created entry at a reused path from inheriting a deleted entry's rows.
 */
export function deriveWorkspaceId(entryPath: string, createdAt?: string): string {
    const pre = typeof createdAt === 'string' && createdAt !== ''
        ? `lore-workspace-id:v2\u0000${entryPath}\u0000${createdAt}`
        : `lore-workspace-id:v1\u0000${entryPath}`;
    const h = createHash('sha256').update(pre).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** An id is MISSING (eligible for backfill) only when absent/null/empty; a present-but-malformed id is left alone. */
const missingId = (w: WorkspaceEntry): boolean => w.id === undefined || w.id === null || w.id === '';

/** Fill in the missing ids on `file` in place. Returns how many entries changed. Pure. */
export function fillMissingIds(file: WorkspacesFile): number {
    let n = 0;
    for (const w of file.workspaces) {
        if (!missingId(w)) continue;
        const sibling = file.workspaces.find((o) => o !== w && o.path === w.path && isValidWorkspaceId(o.id));
        w.id = sibling?.id ?? deriveWorkspaceId(w.path, w.createdAt);
        n++;
    }
    return n;
}

/**
 * Backfill missing ids in `<home>/workspaces.json` atomically and return the registry as it is on disk
 * afterwards (null when there is no registry). Idempotent: a second call writes nothing. Race-safe:
 * ids are deterministic, the file is re-read immediately before each write, and after writing it is
 * re-read and the loop repeats if a concurrent stale write dropped an id.
 */
export function ensureWorkspaceIds(home: string): WorkspacesFile | null {
    for (let attempt = 0; attempt < 4; attempt++) {
        const file = loadWorkspacesIfPresent(home);
        if (!file) return null;
        if (fillMissingIds(file) === 0) return file;
        writeControl(file, home);
        // Re-read and adopt what is on disk (another process may have written in between).
        const after = loadWorkspacesIfPresent(home);
        if (after && !after.workspaces.some(missingId)) return after;
    }
    return loadWorkspacesIfPresent(home);
}
