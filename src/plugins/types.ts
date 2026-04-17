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
}
