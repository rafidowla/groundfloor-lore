/**
 * engineLabels.ts — the engine label the `stats` / `lore_status` MCP tools report
 * for a local workspace (3.35.0).
 *
 * Before 3.35.0 the label was `surreal ? 'surrealdb (local)' : 'legacy graph engine
 * + lancedb (local)'`, so a SQLite-backed workspace (graph AND verbatim on SQLite)
 * was reported as running an engine that was removed. The label is now derived from
 * the engine each substrate actually uses: the graph engine from the registry, the
 * verbatim (vector) engine from the workspace's declared `vectorEngine`.
 */
import path from 'node:path';
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import { resolveWorkspaceVectorEngine } from '../../engines/vectorEngineSelector.js';
import { getWorkspacePath } from '../../config/workspaces.js';
import { surrealDataPath } from '../../engines/surreal/surrealConnection.js';
import { sqliteGraphDataPath } from '../../engines/sqlite/sqliteGraphSchema.js';
import { redactedPostgresLocation } from '../../engines/postgres/postgresPoolOwner.js';

export interface EngineReport {
    /** Human label, e.g. `sqlite (local)`, `surrealdb + lancedb (local)`, `postgres (local)`, `dataplane (cloud)`. */
    engine: string;
    /** Verbatim (vector) store engine; omitted in cloud mode. */
    verbatimEngine?: 'sqlite' | 'lancedb' | 'postgres';
}

/** `registry.homeDir?.()`: partial registries (tests, adapters) may not expose it; the selector then uses the ambient LORE_HOME. */
export function engineReport(registry: LocalGraphRegistry | undefined, workspace: string): EngineReport {
    if (!registry) return { engine: 'dataplane (cloud)' };
    const graph = registry.graphEngineFor(workspace);
    const resolvedVector = resolveWorkspaceVectorEngine(workspace, registry.homeDir?.());
    const verbatim: EngineReport['verbatimEngine'] = resolvedVector === 'sqlite' ? 'sqlite' : resolvedVector === 'postgres' ? 'postgres' : 'lancedb';
    if (graph === 'sqlite' && verbatim === 'sqlite') return { engine: 'sqlite (local)', verbatimEngine: verbatim };
    if (graph === 'postgres' && verbatim === 'postgres') return { engine: 'postgres (local)', verbatimEngine: verbatim };
    const graphLabel = graph === 'sqlite' ? 'sqlite' : graph === 'postgres' ? 'postgres' : graph === 'surreal' ? 'surrealdb' : 'legacy graph engine';
    // Surreal + Lance keeps its historical label so existing consumers see no change.
    if (graph === 'surreal' && verbatim === 'lancedb') return { engine: 'surrealdb (local)', verbatimEngine: verbatim };
    return { engine: `${graphLabel} + ${verbatim} (local)`, verbatimEngine: verbatim };
}

/**
 * workspaceGraphPath — the REAL on-disk graph store location for the engine a
 * local workspace declares: sqlite -> `<ws>/.lore/graph.sqlite`, surreal ->
 * `surrealDataPath(<ws>)` (the resolved path `openSurreal` actually opens, with
 * reserved characters such as spaces URL-escaped), anything else -> the legacy
 * `<ws>/.lore/graph`. Resolved against the workspace's OWN directory; falls back
 * to `fallbackBase` when the name has no workspaces.json entry.
 *
 * Shared by the MCP `stats` tool and HTTP `GET /api/stats` (3.35.1) so both
 * surfaces report the same path from one implementation.
 */
export function workspaceGraphPath(registry: LocalGraphRegistry, workspace: string, fallbackBase: string): string {
    let base = fallbackBase;
    try {
        base = getWorkspacePath(workspace, registry.homeDir());
    } catch {
        // Unknown name: callers resolve the graph handle first, so this is only
        // reachable from partial registries in tests; keep the fallback base.
    }
    const engine = registry.graphEngineFor(workspace);
    if (engine === 'sqlite') return sqliteGraphDataPath(base);
    if (engine === 'surreal') return surrealDataPath(base);
    // Postgres has no on-disk store: report the redacted connection
    // location (postgres://host:port/db, credentials dropped — the ONLY
    // loggable shape of the URL, see redactPgUrl).
    if (engine === 'postgres') return redactedPostgresLocation();
    return path.join(base, '.lore', 'graph');
}
