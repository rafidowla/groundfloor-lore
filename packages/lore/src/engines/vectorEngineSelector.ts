/**
 * vectorEngineSelector.ts — which engine backs a workspace's VECTOR substrate.
 *
 * 3.21 step 2 part 2 (design: 321-STEP2-SQLITE-VECTOR-AND-PROMOTION-DESIGN.md
 * section 2, "Selection and default"). Mirrors `graphEngineSelector.ts`
 * exactly, minus the legacy-engine refusal (there is no removed vector
 * engine to reject here — only two live choices).
 *
 * `resolveWorkspaceVectorEngine` reads `WorkspaceEntry.vectorEngine` from
 * workspaces.json; an absent field falls through to `DEFAULT_VECTOR_ENGINE`
 * ('lance'), so no existing workspace changes substrate because this field
 * was added. `resolveNewWorkspaceVectorEngine` is what `createWorkspace()`
 * and fresh-home seeding WRITE explicitly for a brand-new local workspace —
 * defaults to 'sqlite', with `LORE_DEFAULT_VECTOR_ENGINE=lance` as the
 * documented operator escape hatch (docs/CONFIGURATION.md,
 * security/envScrub.ts allowlist).
 *
 * This module deliberately does NOT import either store engine: it is a
 * config read, so it can be used anywhere (including cli commands that only
 * want to print a banner) without dragging LanceDB/better-sqlite3 into the
 * module graph.
 */

import { loadWorkspaces } from '../config/workspaces.js';

/** The engines that can back the vector substrate of a local workspace. */
export type VectorEngineKind = 'lance' | 'sqlite';

/**
 * The default, and what an absent selector means — for a workspace that has
 * NEVER been given an explicit `vectorEngine`. Every workspace created
 * before 3.21 predates this field, and MUST keep running on LanceDB.
 */
export const DEFAULT_VECTOR_ENGINE: VectorEngineKind = 'lance';

/**
 * resolveWorkspaceVectorEngine — the engine backing `workspace`'s vectors.
 *
 * Never throws for an unknown workspace: an unregistered name resolves to
 * the default, because the caller's next step (opening it) produces the
 * real, better error. Same "never throws" contract as
 * `resolveWorkspaceGraphEngine`.
 */
export function resolveWorkspaceVectorEngine(workspace: string, home?: string): VectorEngineKind {
    try {
        const file = loadWorkspaces(home);
        const entry = file.workspaces.find((w) => w.name === workspace);
        if (entry?.vectorEngine === 'sqlite') return 'sqlite';
        if (entry?.vectorEngine === 'lance') return 'lance';
        return DEFAULT_VECTOR_ENGINE;
    } catch {
        // Unreadable/absent workspaces.json — the daemon has bigger
        // problems, and the incumbent engine is the safe assumption.
        return DEFAULT_VECTOR_ENGINE;
    }
}

/**
 * resolveVectorEngineForPath — same path-matching fallback
 * `resolveGraphEngineForPath` (openWorkspaceGraph.ts) uses, for callers
 * (CLI status/doctor) that only have a base path, not a workspace name.
 */
export function resolveVectorEngineForPath(
    basePath: string,
    opts: { workspaceId?: string; home?: string } = {},
): { engine: VectorEngineKind; workspace: string | null } {
    if (opts.workspaceId) {
        return { engine: resolveWorkspaceVectorEngine(opts.workspaceId, opts.home), workspace: opts.workspaceId };
    }
    try {
        const file = loadWorkspaces(opts.home);
        const norm = (p: string): string => p.replace(/\/+$/, '');
        const match = file.workspaces.find((w) => norm(w.path) === norm(basePath));
        if (match) {
            return { engine: resolveWorkspaceVectorEngine(match.name, opts.home), workspace: match.name };
        }
    } catch {
        // An unreadable/absent workspaces.json is normal for a bare path.
    }
    return { engine: DEFAULT_VECTOR_ENGINE, workspace: null };
}

/**
 * resolveNewWorkspaceVectorEngine — the value `createWorkspace()` and
 * fresh-home seeding WRITE explicitly for a brand-NEW local workspace (3.21
 * step 2 part 2). Never used to resolve an EXISTING workspace — that stays
 * `resolveWorkspaceVectorEngine`, whose absent-field default is unaffected.
 *
 * Defaults to `'sqlite'`. `LORE_DEFAULT_VECTOR_ENGINE=lance` is the
 * documented operator escape hatch for a host that isn't ready to switch —
 * any other value, or an absent/unset var, is 'sqlite'. Cloud mode never
 * calls this (there is no cloud counterpart to either local vector engine).
 */
export function resolveNewWorkspaceVectorEngine(): VectorEngineKind {
    return process.env['LORE_DEFAULT_VECTOR_ENGINE'] === 'lance' ? 'lance' : 'sqlite';
}
