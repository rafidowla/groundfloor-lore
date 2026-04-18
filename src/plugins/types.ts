/**
 * types.ts — Core interfaces for the Lore V2 plugin system.
 *
 * A plugin is the smallest unit that can be activated/deactivated in a
 * workspace. Active plugins are read from .lore/config.json → `plugins[]`.
 * Each plugin contributes:
 *
 *   - Tools     : MCP tool registrations gated by plugin activation
 *   - Schemas   : additional node types and edge relations beyond the base
 *   - Tables    : Kùzu table names it owns (used for collision checks +
 *                 orphan detection on plugin removal)
 *   - UI hints  : default filter preset, default system prompt, camera focus
 *                 tag (consumed by the Mode pill-group in Phase 3)
 *   - Telemetry : optional `getTelemetryPayload()` used by the Dataplane
 *                 sync in Phase 4+
 *
 * The plugin registry (registry.ts) loads and validates plugins; the core
 * server never imports plugin tool registrations directly.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * PluginGraphContext — Narrow surface exposed to plugins for reading from
 * or writing to the Kùzu graph without importing the LocalGraph class
 * directly (which would invert the dependency).
 *
 * Handed to registerSchema / contributeReconnectNodes / routeReconnectEdge.
 * The executeQuery signature mirrors kuzu-lite's so plugins can run raw
 * Cypher when they need to.
 */
export interface PluginGraphContext {
    /**
     * Execute a parameterized Cypher query. Plugins use this both for
     * schema creation (CREATE NODE TABLE …) and for operational reads.
     * Throws on syntax / execution error; caller decides to recover.
     */
    executeQuery(cypher: string, params?: Record<string, unknown>): Promise<unknown>;

    /**
     * Materialized row list helper — common enough to hoist out of every
     * plugin. Returns an array of plain objects keyed by the RETURN names.
     */
    queryRows(cypher: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
}

/**
 * EmbeddableNode — What plugins hand back from `contributeReconnectNodes`.
 * The id is already prefixed (e.g. `file:src/foo.ts`, `symbol:abc123`) so
 * a single vector search returns hits across all pillars and the core
 * pass can route results by prefix.
 */
export interface EmbeddableNode {
    id: string;
    text: string;
    metadata: {
        type: string;
        label: string;
        tags: string;
        project: string;
        ecosystem: string;
        updatedAt: string;
        security_scopes: string[];
    };
}

/**
 * ReconnectEdgeProposal — One semantic edge candidate for the plugin to
 * route into the correct REL table. The plugin returns `true` if it
 * accepted the edge; `false` lets the next plugin (or core) try.
 *
 * Both ids carry their pillar prefix so plugins can pattern-match on
 * kind without another lookup.
 */
export interface ReconnectEdgeProposal {
    from: string;
    to: string;
    confidence: number;
    relation: string; // already formatted e.g. "semantic_neighbor:0.842"
}

/**
 * PluginContext — Shared runtime handed to each plugin's tool registrar.
 * Kept intentionally minimal and fully typed. Anything not on here a
 * plugin cannot reach (enforced by the registry).
 */
export interface PluginContext {
    // Service singletons. `unknown` at the interface level to avoid a
    // circular dependency between plugins and engines; plugins that need
    // these cast to the concrete classes they import directly.
    graph: unknown;
    verbatimStore: unknown;
    syncEngine: unknown;
    syncAdapter: unknown | null;
    schemaLoader: unknown;

    // Workspace scope (project + ecosystem autoresolved from cwd).
    scope: { project: string; ecosystem: string };

    // Loreroot. Plugins that manage their own persistence should write
    // beneath `${loreDir}/plugins/${pluginName}/...`.
    loreDir: string;
}

/**
 * PluginUiHints — Phase 3 Mode pill behavior.
 * Clicking a mode pill swaps system prompt, filter preset, and camera focus.
 */
export interface PluginUiHints {
    /** Short label shown on the pill (e.g., "Developer", "Family"). */
    modeLabel: string;
    /** System prompt swap for chat when this mode is active. */
    systemPrompt: string;
    /** Default node types to show (Sigma `nodeReducer` preset). */
    defaultFilterTypes: string[];
    /** Camera focuses on the densest cluster whose nodes carry this tag. */
    cameraFocusTag: string;
}

export interface PluginTelemetryPayload {
    pluginName: string;
    version: string;
    nodeCount: number;
    edgeCount: number;
    tableNames: string[];
}

/**
 * ILorePlugin — The contract every plugin must satisfy.
 * Must be a pure object (no module-level side effects on import) so the
 * registry can introspect without booting the plugin.
 */
export interface ILorePlugin {
    /** Kebab-case plugin id; matches the string in config.plugins[]. */
    name: string;
    version: string;
    description: string;

    /**
     * Kùzu table names this plugin owns. Used for:
     *   (a) collision checks across active plugins at boot
     *   (b) orphan detection when a plugin is deactivated
     */
    ownedTables: string[];

    /** Additional node / edge kinds this plugin introduces. */
    nodeTypes: string[];
    edgeRelations: string[];

    /** UI behavior for the Mode pill (Phase 3). */
    uiHints: PluginUiHints;

    /**
     * Register all MCP tools this plugin contributes. Called by the
     * registry only if the plugin is active.
     */
    registerTools(server: McpServer, ctx: PluginContext): void;

    /**
     * Dataplane telemetry payload. Phase 4 ships a health-ping only; the
     * full contract consumes this. Returning null opts out.
     */
    getTelemetryPayload?(ctx: PluginContext): Promise<PluginTelemetryPayload | null>;

    /**
     * V2.1 — register additional Kùzu node / rel tables the plugin needs.
     * Called exactly once at boot after the core graph is initialized.
     * Plugins issue CREATE … IF NOT EXISTS statements through ctx.executeQuery.
     * Returning an error throws the boot — collisions here are fatal.
     */
    registerSchema?(ctx: PluginGraphContext): Promise<void>;

    /**
     * V2.1 — contribute additional nodes to the reconnect pass's vector
     * space. Core embeds LoreNode by default; plugins can add their own
     * node kinds (e.g. code_file, code_symbol) so cross-pillar semantic
     * edges are possible.
     *
     * Returned ids MUST be prefixed so the core pass can route without
     * a reverse lookup. Recommended prefixes: '<kind>:<id>'.
     */
    contributeReconnectNodes?(ctx: PluginGraphContext): Promise<EmbeddableNode[]>;

    /**
     * V2.1 — given a semantic edge proposal involving one or both of the
     * plugin's node kinds, route it into the correct rel table. Return
     * `true` if this plugin handled the edge; `false` to let the next
     * participant try. Core handles pure lore↔lore so plugins only see
     * cross-pillar candidates.
     */
    routeReconnectEdge?(proposal: ReconnectEdgeProposal, ctx: PluginGraphContext): Promise<boolean>;

    /**
     * V2.1 — prune any inferred edges this plugin owns. Called before a
     * reconnect pass's insert phase so re-runs don't duplicate. Plugins
     * prune only their own rel tables, identified by relation-prefix.
     * Returns the number of edges deleted (for stats/logging).
     */
    pruneInferredEdges?(relationPrefix: string, ctx: PluginGraphContext): Promise<number>;
}
