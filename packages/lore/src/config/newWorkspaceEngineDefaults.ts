/**
 * newWorkspaceEngineDefaults.ts — which graph / vector engine a NEW local
 * workspace is written with, from the operator escape-hatch env vars.
 *
 * A leaf module (no imports) because both `config/workspaces.ts` and the
 * engine selectors need it and the selectors import `workspaces.ts`.
 * `postgres` is accepted so a Postgres-backed deployment can make it the
 * default for new workspaces; opening such a workspace then requires
 * `LORE_PG_URL` and fails loudly without it (never a fallback).
 * Any other value, or an unset var, gives the 3.21 default: `sqlite`.
 */

export type NewWorkspaceGraphEngine = 'sqlite' | 'surreal' | 'postgres';
export type NewWorkspaceVectorEngine = 'sqlite' | 'lance' | 'postgres';

export function newWorkspaceGraphEngineFromEnv(): NewWorkspaceGraphEngine {
    const v = process.env['LORE_DEFAULT_GRAPH_ENGINE'];
    return v === 'surreal' || v === 'postgres' ? v : 'sqlite';
}

export function newWorkspaceVectorEngineFromEnv(): NewWorkspaceVectorEngine {
    const v = process.env['LORE_DEFAULT_VECTOR_ENGINE'];
    return v === 'lance' || v === 'postgres' ? v : 'sqlite';
}
