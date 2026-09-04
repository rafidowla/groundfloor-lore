/**
 * graphEngineSelector.ts — which engine backs a workspace's GRAPH substrate.
 *
 * `resolveWorkspaceGraphEngine` reads `WorkspaceEntry.graphEngine` from
 * workspaces.json; an absent field falls through to `DEFAULT_GRAPH_ENGINE`
 * ('surreal').
 *
 * This module used to also export a loud refusal for the schema-safety
 * subsystem's raw-Cypher-only code paths (blast radius, the
 * pre-destructive-change snapshot, the migration backend), because on a
 * Surreal-backed workspace the raw-Cypher-only table those paths targeted
 * was real but EMPTY, so those paths would silently succeed with zero
 * affected rows instead of failing. That refusal is gone: the three
 * consumers were rewired onto the engine-agnostic `SchemaGraphOps` port
 * (`schemas/substrate/schemaGraphOps.ts`), which answers correctly on
 * either engine instead of needing to be refused on one of them. See
 * DECISIONS.md.
 *
 * `GraphSubstrateUnsupportedError` stays — `bootSteps.ts`'s
 * `buildGraphReaders` still throws it for the residual case of a graph
 * handle exposing neither the SurrealDB port nor a raw Cypher hatch.
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
 * 'surreal' became the only IMPLEMENTED engine once the prior local graph
 * implementation was deleted (2026-08-21). `resolveWorkspaceGraphEngine` still
 * returns 'kuzu' for an EXPLICIT declaration so callers can fail LOUDLY on it
 * (`legacyGraphEngineRemovedError` — a legacy graph engine declaration is no longer
 * supported) instead of silently falling back to SurrealDB — which would
 * read and write the WRONG store for a workspace whose data is still in
 * `.lore/graph`. That silent fallback is the exact bug class behind the
 * pm-scope-app incident; see DECISIONS.md.
 */
export const DEFAULT_GRAPH_ENGINE: GraphEngineKind = 'surreal';

/**
 * A legacy graph engine declaration is no longer supported: `LocalGraph` and
 * every module specific to that removed engine were deleted. A workspace
 * that still EXPLICITLY declares `graphEngine: 'kuzu'` in workspaces.json
 * cannot be served, and every engine-resolving entry point must fail with
 * THIS error rather than silently substitute SurrealDB — a silent fallback
 * would create/read an empty Surreal store while the workspace's real data
 * sits untouched and invisible in `.lore/graph` (reads return nothing,
 * writes land in the wrong database, both report success). This is the
 * loud-failure principle from the pm-scope-app incident, applied at the
 * engine boundary.
 *
 * Shaped like `CloudModeUnsupportedError` (`code` + `status`) so HTTP routes
 * and MCP tools map it uniformly without parsing strings. 501 is the honest
 * status: the request is valid, this deployment cannot serve this workspace.
 */
export class LegacyGraphEngineRemovedError extends Error {
    public readonly code = 'legacy_graph_engine_removed' as const;
    public readonly status = 501 as const;
    public readonly workspace: string | null;
    constructor(workspace: string | null, context: string) {
        super(
            `${context}: workspace ${workspace ? `'${workspace}' ` : '(matched by path) '}`
            + "declares graphEngine 'kuzu' in workspaces.json, but a legacy graph engine "
            + 'declaration is no longer supported. Refusing to silently fall back to SurrealDB: '
            + 'that would read and write a different, empty store while this workspace\'s real '
            + 'data sits in .lore/graph untouched. To continue: edit workspaces.json and '
            + 'set this workspace\'s "graphEngine" to "surreal" (or remove the field). If the '
            + 'old data is still needed, migrate it BEFORE switching engines.',
        );
        this.name = 'LegacyGraphEngineRemovedError';
        this.workspace = workspace;
    }
}

/** Throw the loud legacy-engine-removed refusal (see `LegacyGraphEngineRemovedError`). */
export function legacyGraphEngineRemovedError(workspace: string | null, context: string): never {
    throw new LegacyGraphEngineRemovedError(workspace, context);
}

/**
 * Raised when an operation that can only be expressed as raw Cypher is
 * attempted against a workspace whose graph substrate doesn't support it.
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
            + `This path reads or writes nodes/edges through raw Cypher${detail}, `
            + 'and the graph substrate for this workspace does not support raw Cypher access. '
            + 'It is refused rather than run because the target node table may be EMPTY here — '
            + 'running it would return a silently wrong answer instead of an error. '
            + 'See DECISIONS.md DEC-SURREAL-RUNTIME.',
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
 * `legacyGraphEngineRemovedError` where the workspace name and context are known
 * (`openWorkspaceGraph`, `LocalGraphRegistry.getGraphHandle`).
 */
export function resolveWorkspaceGraphEngine(workspace: string, home?: string): GraphEngineKind {
    try {
        const file = loadWorkspaces(home);
        const entry = file.workspaces.find((w) => w.name === workspace);
        // An EXPLICIT declaration always wins, either direction — only an
        // absent field falls through to the default. Collapsing "explicit
        // legacy engine" into "not explicit surreal" was harmless while the
        // default itself was 'kuzu' (same outcome either way), but became a real bug
        // the moment the default could be 'surreal': a workspace that
        // explicitly opted OUT of surreal would have been silently switched
        // onto it anyway, reading a fresh empty store while its real data
        // sat untouched and invisible.
        if (entry?.graphEngine === 'surreal') return 'surreal';
        if (entry?.graphEngine === 'kuzu') return 'kuzu';
        return DEFAULT_GRAPH_ENGINE;
    } catch {
        // Unreadable/absent workspaces.json — the daemon has bigger problems,
        // and the incumbent engine is the safe assumption.
        return DEFAULT_GRAPH_ENGINE;
    }
}

