/**
 * graphEngineSelector.ts — which engine backs a workspace's GRAPH substrate.
 *
 * `resolveWorkspaceGraphEngine` reads `WorkspaceEntry.graphEngine` from
 * workspaces.json; an absent field falls through to `DEFAULT_GRAPH_ENGINE`
 * ('surreal').
 *
 * This module used to also export `assertKuzuGraphSubstrate` — a loud
 * refusal for the schema-safety subsystem's raw-Kùzu-Cypher code paths
 * (blast radius, the pre-destructive-change snapshot, the migration
 * backend), because on a Surreal-backed workspace the Kùzu `LoreNode` table
 * was real but EMPTY, so those paths would silently succeed with zero
 * affected rows instead of failing. That refusal is gone: the three
 * consumers were rewired onto the engine-agnostic `SchemaGraphOps` port
 * (`schemas/substrate/schemaGraphOps.ts`), which answers correctly on
 * either engine instead of needing to be refused on one of them. See
 * DECISIONS.md and docs/audit/KUZU-REMOVAL-*.md.
 *
 * `GraphSubstrateUnsupportedError` stays — `bootSteps.ts`'s
 * `buildGraphReaders` still throws it for the residual case of a graph
 * handle exposing neither the SurrealDB port nor the Kùzu Cypher hatch.
 *
 * This module deliberately does NOT import either engine: it is a config
 * read plus (optionally) a throw, so it can be used anywhere without
 * dragging a native addon into the module graph.
 */

import { loadWorkspaces } from '../config/workspaces.js';

/** The engines that can back the graph substrate of a local workspace. */
export type GraphEngineKind = 'kuzu' | 'surreal';

/**
 * The default, and what an absent selector means — for a workspace that has
 * NEVER been given an explicit `graphEngine`. Flipped to 'surreal' 2026-08-11;
 * 'surreal' became the only IMPLEMENTED engine when LocalGraph was deleted
 * (Kùzu removal Phase 3d, 2026-08-21). `resolveWorkspaceGraphEngine` still
 * returns 'kuzu' for an EXPLICIT declaration so callers can fail LOUDLY on it
 * (`kuzuEngineRemovedError`) instead of silently falling back to SurrealDB —
 * which would read and write the WRONG store for a workspace whose data is
 * still in `.lore/graph`. That silent fallback is the exact bug class behind
 * the pm-scope-app incident; see DECISIONS.md (Kùzu removal).
 */
export const DEFAULT_GRAPH_ENGINE: GraphEngineKind = 'surreal';

/**
 * Kùzu support was removed from Lore (Phase 3d, 2026-08-21): LocalGraph and
 * every Kùzu-only module were deleted. A workspace that still EXPLICITLY
 * declares `graphEngine: 'kuzu'` in workspaces.json cannot be served, and
 * every engine-resolving entry point must fail with THIS error rather than
 * silently substitute SurrealDB — a silent fallback would create/read an
 * empty Surreal store while the workspace's real Kùzu data sits untouched
 * and invisible in `.lore/graph` (reads return nothing, writes land in the
 * wrong database, both report success). This is the loud-failure principle
 * from the pm-scope-app incident, applied at the engine boundary.
 *
 * Shaped like `CloudModeUnsupportedError` (`code` + `status`) so HTTP routes
 * and MCP tools map it uniformly without parsing strings. 501 is the honest
 * status: the request is valid, this deployment cannot serve this workspace.
 */
export class KuzuEngineRemovedError extends Error {
    public readonly code = 'kuzu_engine_removed' as const;
    public readonly status = 501 as const;
    public readonly workspace: string | null;
    constructor(workspace: string | null, context: string) {
        super(
            `${context}: workspace ${workspace ? `'${workspace}' ` : '(matched by path) '}`
            + 'declares graphEngine \'kuzu\' in workspaces.json, but Kùzu support has been '
            + 'removed from Lore (2026-08-21). Refusing to silently fall back to SurrealDB: '
            + 'that would read and write a different, empty store while this workspace\'s real '
            + 'Kùzu data sits in .lore/graph untouched. To continue: edit workspaces.json and '
            + 'set this workspace\'s "graphEngine" to "surreal" (or remove the field). If the '
            + 'Kùzu data is still needed, migrate it BEFORE switching engines.',
        );
        this.name = 'KuzuEngineRemovedError';
        this.workspace = workspace;
    }
}

/** Throw the loud Kùzu-removed refusal (see `KuzuEngineRemovedError`). */
export function kuzuEngineRemovedError(workspace: string | null, context: string): never {
    throw new KuzuEngineRemovedError(workspace, context);
}

/**
 * Raised when an operation that can only be expressed as raw Kùzu Cypher is
 * attempted against a workspace whose graph substrate is somewhere else.
 *
 * Shaped like `CloudModeUnsupportedError` (`code` + `status`) so HTTP routes
 * and MCP tools map it uniformly without parsing strings. 501 is the honest
 * status: the request is valid, this deployment cannot serve it.
 */
export class GraphSubstrateUnsupportedError extends Error {
    public readonly code = 'graph_substrate_unsupported' as const;
    public readonly status = 501 as const;
    public readonly operation: string;
    public readonly engine: GraphEngineKind;
    constructor(operation: string, engine: GraphEngineKind, hint?: string) {
        const detail = hint ? ` (${hint})` : '';
        super(
            `${operation}: not available on a '${engine}'-backed workspace. `
            + `This path reads or writes nodes/edges through raw Kùzu Cypher${detail}, `
            + 'and the graph substrate for this workspace is not Kùzu. It is refused rather '
            + 'than run because the Kùzu node table is EMPTY here — running it would return a '
            + 'silently wrong answer instead of an error. See DECISIONS.md DEC-SURREAL-RUNTIME.',
        );
        this.name = 'GraphSubstrateUnsupportedError';
        this.operation = operation;
        this.engine = engine;
    }
}

/**
 * resolveWorkspaceGraphEngine — the engine backing `workspace`'s graph.
 *
 * Never throws for an unknown workspace: an unregistered name resolves to the
 * default, because the caller's next step (opening it) produces the real,
 * better error. A selector lookup is not the place to fail workspace
 * resolution. Note the engine REMOVED case is also not thrown here — callers
 * get 'kuzu' back for an explicit declaration and must route it to
 * `kuzuEngineRemovedError` where the workspace name and context are known
 * (`openWorkspaceGraph`, `LocalGraphRegistry.getGraphHandle`).
 */
export function resolveWorkspaceGraphEngine(workspace: string, home?: string): GraphEngineKind {
    try {
        const file = loadWorkspaces(home);
        const entry = file.workspaces.find((w) => w.name === workspace);
        // An EXPLICIT declaration always wins, either direction — only an
        // absent field falls through to the default. Collapsing "explicit
        // kuzu" into "not explicit surreal" was harmless while the default
        // itself was 'kuzu' (same outcome either way), but became a real bug
        // the moment the default could be 'surreal': a workspace that
        // explicitly opted OUT of surreal would have been silently switched
        // onto it anyway, reading a fresh empty store while its real Kùzu
        // data sat untouched and invisible.
        if (entry?.graphEngine === 'surreal') return 'surreal';
        if (entry?.graphEngine === 'kuzu') return 'kuzu';
        return DEFAULT_GRAPH_ENGINE;
    } catch {
        // Unreadable/absent workspaces.json — the daemon has bigger problems,
        // and the incumbent engine is the safe assumption.
        return DEFAULT_GRAPH_ENGINE;
    }
}

