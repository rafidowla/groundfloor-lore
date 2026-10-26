/**
 * postgresWorkspaceKey.ts — the Postgres row key of a workspace is its PERMANENT id.
 *
 * Every Postgres table keys its rows by `workspace_id`. That column holds the registry entry's permanent
 * `id` (config/workspaceIds.ts), never the workspace NAME: a name can be renamed, and after a delete it can
 * be reused by a different workspace, so name-keyed rows were orphaned by a rename and re-attached to the
 * new owner of a reused name. See postgresRekey.ts for the one-time rewrite of rows written before this.
 *
 * {@link resolvePostgresWorkspaceKey} is the ONE place an open path turns a name into the key. There is no
 * fallback to the name: when the registry has no usable id for the workspace it throws a typed
 * {@link PostgresWorkspaceKeyError}. It also remembers which registry home the id came from, so the store
 * that opens with that id can run the name-to-id rewrite against the right registry
 * ({@link registryHomeForKey}).
 *
 * Constructing a store directly with a key (tests, tools that already hold an id) is allowed and skips the
 * rewrite: a key that was never resolved here has no registry to read names from.
 */

import { ensureWorkspaceIds, isValidWorkspaceId } from '../../config/workspaceIds.js';
import { loreHome } from '../../config/loreHome.js';

export class PostgresWorkspaceKeyError extends Error {
    public readonly code = 'postgres_workspace_key_missing' as const;
    constructor(public readonly workspace: string, reason: string) {
        super(`Cannot key Postgres rows for workspace '${workspace}': ${reason}. `
            + `Postgres rows are keyed by the workspace's permanent id, never its name, so Lore will not open it.`);
        this.name = 'PostgresWorkspaceKeyError';
    }
}

/** key (permanent id) -> the registry home it was resolved from. Process-wide; ids are globally unique. */
const registryHomes = new Map<string, string>();

/**
 * The permanent id to use as `workspace_id` for the workspace called `name` in the registry at `home`
 * (default: the Lore home). Backfills missing ids in that registry (atomic, deterministic). Throws
 * {@link PostgresWorkspaceKeyError} when there is no registry, no such entry, or no valid id.
 */
export function resolvePostgresWorkspaceKey(name: string, home: string = loreHome()): string {
    if (typeof name !== 'string' || name.trim() === '') throw new PostgresWorkspaceKeyError(String(name), 'the workspace name is empty');
    let file;
    try {
        file = ensureWorkspaceIds(home);
    } catch (e) {
        throw new PostgresWorkspaceKeyError(name, `the workspace registry in ${home} could not be read or updated (${(e as Error).message})`);
    }
    if (!file) throw new PostgresWorkspaceKeyError(name, `there is no workspace registry (workspaces.json) in ${home}`);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new PostgresWorkspaceKeyError(name, `the registry in ${home} has no workspace with that name`);
    if (!isValidWorkspaceId(entry.id)) throw new PostgresWorkspaceKeyError(name, `its registry entry has no valid permanent id`);
    registryHomes.set(entry.id, home);
    return entry.id;
}

/** The registry home a key was resolved from, or undefined when the key never went through the resolver. */
export function registryHomeForKey(key: string): string | undefined {
    return registryHomes.get(key);
}
