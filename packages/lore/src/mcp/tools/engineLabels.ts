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
import type { LocalGraphRegistry } from '../../engines/localGraphRegistry.js';
import { resolveWorkspaceVectorEngine } from '../../engines/vectorEngineSelector.js';

export interface EngineReport {
    /** Human label, e.g. `sqlite (local)`, `surrealdb + lancedb (local)`, `dataplane (cloud)`. */
    engine: string;
    /** Verbatim (vector) store engine; omitted in cloud mode. */
    verbatimEngine?: 'sqlite' | 'lancedb';
}

/** `registry.homeDir?.()`: partial registries (tests, adapters) may not expose it; the selector then uses the ambient LORE_HOME. */
export function engineReport(registry: LocalGraphRegistry | undefined, workspace: string): EngineReport {
    if (!registry) return { engine: 'dataplane (cloud)' };
    const graph = registry.graphEngineFor(workspace);
    const verbatim = resolveWorkspaceVectorEngine(workspace, registry.homeDir?.()) === 'sqlite' ? 'sqlite' : 'lancedb';
    if (graph === 'sqlite' && verbatim === 'sqlite') return { engine: 'sqlite (local)', verbatimEngine: verbatim };
    const graphLabel = graph === 'sqlite' ? 'sqlite' : graph === 'surreal' ? 'surrealdb' : 'legacy graph engine';
    // Surreal + Lance keeps its historical label so existing consumers see no change.
    if (graph === 'surreal' && verbatim === 'lancedb') return { engine: 'surrealdb (local)', verbatimEngine: verbatim };
    return { engine: `${graphLabel} + ${verbatim} (local)`, verbatimEngine: verbatim };
}
