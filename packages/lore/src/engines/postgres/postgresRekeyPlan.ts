/**
 * postgresRekeyPlan.ts — which name-keyed Postgres rows belong to which permanent workspace id.
 *
 * Pure, registry-only (no database): turns the live registry (workspaces.json) and the deletion log
 * (workspace-deletions.jsonl) into "for each permanent id, the names its old rows may sit under".
 *
 * Rules:
 *   - A live entry owns its name. Aliases (several entries sharing one id) all map to that id.
 *   - A deleted (held) workspace owns its recorded name ONLY if no live entry and no later-deleted workspace
 *     claims it. A name claimed by both a live and a deleted workspace is ambiguous in the data (the rows were
 *     written by whichever workspace held the name); the live workspace wins and the loser is reported in
 *     `shadowed` so the log line can say so.
 *   - Deleted workspaces that were restored are live again and appear in the registry; they are skipped here.
 *   - A name that equals its own id has nothing to rewrite.
 */

import { readDeletionLog } from '../../config/deletedWorkspaces.js';
import { isValidWorkspaceId } from '../../config/workspaceIds.js';
import { loadWorkspacesIfPresent } from '../../config/workspaces.js';

export interface RekeyTarget {
    /** The permanent id the rows must end up under. */
    id: string;
    /** Names the old rows may sit under (never contains the id itself). */
    names: string[];
    /** True for a workspace that is deleted (held) rather than live. */
    deleted: boolean;
}

export interface RekeyPlan {
    targets: RekeyTarget[];
    /** Every id in the registry and deletion log (live and deleted). */
    knownIds: string[];
    /** Deleted workspaces whose name is also used by a live (or later-deleted) workspace: the name's rows go to the other one. */
    shadowed: Array<{ id: string; name: string }>;
}

export function buildRekeyPlan(home: string): RekeyPlan {
    const file = loadWorkspacesIfPresent(home);
    const live = (file?.workspaces ?? []).filter((w) => isValidWorkspaceId(w.id));
    const namesById = new Map<string, Set<string>>();
    const deletedIds = new Set<string>();
    const claimed = new Map<string, string>(); // name -> id
    for (const w of live) {
        const id = w.id as string;
        if (!namesById.has(id)) namesById.set(id, new Set());
        if (w.name !== id) namesById.get(id)!.add(w.name);
        if (!claimed.has(w.name)) claimed.set(w.name, id);
    }
    const liveIds = new Set(namesById.keys());

    const shadowed: Array<{ id: string; name: string }> = [];
    const deleted = [...readDeletionLog(home).byId.entries()]
        .filter(([id, s]) => isValidWorkspaceId(id) && s.deletion && !s.restored && !liveIds.has(id))
        .sort((a, b) => (b[1].deletion!.deletedAt ?? '').localeCompare(a[1].deletion!.deletedAt ?? '')); // latest first
    for (const [id, state] of deleted) {
        deletedIds.add(id);
        if (!namesById.has(id)) namesById.set(id, new Set());
        const name = state.deletion!.name;
        if (typeof name !== 'string' || name === '' || name === id) continue;
        if (claimed.has(name) && claimed.get(name) !== id) { shadowed.push({ id, name }); continue; }
        claimed.set(name, id);
        namesById.get(id)!.add(name);
    }

    const targets: RekeyTarget[] = [...namesById.entries()]
        .map(([id, names]) => ({ id, names: [...names].sort(), deleted: deletedIds.has(id) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    return { targets, knownIds: targets.map((t) => t.id), shadowed };
}
