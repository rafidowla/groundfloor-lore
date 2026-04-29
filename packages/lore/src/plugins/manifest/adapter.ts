/**
 * adapter.ts — Synthesise an `ILorePlugin` from a Tier 1 manifest.
 *
 * A manifest declaring `lore.schema` (and no `lore.module`) describes a
 * pure-data plugin — node-type names + edge-relation names that should
 * become valid entries in core's `store_node` / `store_edge` enums when
 * the plugin is active. There is no TypeScript code to import.
 *
 * This adapter takes such a manifest and returns a minimal `ILorePlugin`
 * object that the existing PluginRegistry can load through its normal
 * boot path. The synthetic plugin:
 *
 *   - Reports identity (`name`, `version`, `description`) from the manifest.
 *   - Has empty `ownedTables` / `nodeTypes` / `edgeRelations` arrays
 *     (these are the *parallel-compat* fields used before contributeNodeTypes
 *     existed; the Q1.4 IR + the contribute hooks below are the canonical
 *     paths).
 *   - Implements `contributeNodeTypes()` returning the manifest's node types.
 *   - Implements `contributeEdgeRelations()` returning the manifest's edge
 *     relations.
 *   - Provides a no-op `registerTools` (Tier 1 plugins contribute no tools).
 *   - Provides default `uiHints` (Mode pill behaviour). Tier 1 plugins use
 *     the "all-defaults" preset; richer presets are a Tier 2/3 concern.
 *
 * Why this lives next to the loader: the loader already knows about
 * manifests and produces `ValidatedManifest` objects. The adapter is the
 * smallest extension that turns a validated manifest into something the
 * existing registry can consume without per-plugin code changes.
 *
 * The adapter is pure — no IO, no globals — so it's straightforward to
 * unit-test against in-memory manifest objects.
 */

import type {
    ILorePlugin,
    PluginUiHints,
    PluginContext,
} from '../types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PluginManifest, SchemaNodeType, SchemaEdgeRelation } from '../manifest.js';
import { registerAutoTools } from './autoTools.js';

export class ManifestPluginAdapterError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ManifestPluginAdapterError';
        Object.setPrototypeOf(this, ManifestPluginAdapterError.prototype);
    }
}

const DEFAULT_UI_HINTS: PluginUiHints = {
    modeLabel: '',
    systemPrompt: '',
    defaultFilterTypes: [],
    cameraFocusTag: '',
};

/**
 * Build an `ILorePlugin` from a validated manifest. Throws
 * `ManifestPluginAdapterError` if the manifest's `lore.schema` block is
 * missing — callers should prefer the JS module path
 * (`require(manifest.lore.module)`) for non-Tier-1 plugins.
 *
 * Note: the manifest is expected to have already been validated via
 * `validateManifest`. Field-level diagnostics are not re-checked here.
 */
export function manifestToPlugin(manifest: PluginManifest): ILorePlugin {
    if (!manifest.lore) {
        throw new ManifestPluginAdapterError(
            `manifest "${manifest.name}" has no \`lore\` contribution; cannot synthesise a Lore plugin`,
        );
    }

    const schema = manifest.lore.schema;
    if (!schema) {
        throw new ManifestPluginAdapterError(
            `manifest "${manifest.name}" has no \`lore.schema\` block; ` +
            `manifestToPlugin only handles Tier 1 (declarative) plugins. ` +
            `For TypeScript plugins, load \`lore.module\` instead.`,
        );
    }

    const nodeTypes: SchemaNodeType[] = schema.nodeTypes ?? [];
    const edgeRelations: SchemaEdgeRelation[] = schema.edgeRelations ?? [];

    // Defensive copies so downstream callers can't mutate the manifest in-place.
    const frozenNodeTypes = nodeTypes.map((t) => ({ name: t.name, description: t.description }));
    const frozenEdgeRelations = edgeRelations.map((e) => ({ name: e.name, description: e.description }));

    const synthetic: ILorePlugin = {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,

        // Tier 1 plugins don't own Kùzu tables; their types live on the
        // shared LoreNode + LoreEdge tables via the type discriminator.
        ownedTables: [],

        // The legacy parallel-compat fields. Today the Q1.4 IR + the
        // contribute hooks below supersede these, but they're still on
        // the interface as required fields, so populate them too.
        nodeTypes: frozenNodeTypes.map((t) => t.name),
        edgeRelations: frozenEdgeRelations.map((e) => e.name),

        // Q1.4 IR — declarative, prefers ownedNodeTables / ownedEdgeTables
        // over the legacy fields when present. Tier 1 owns no tables.
        ir: {
            version: manifest.version,
            ownedNodeTables: [],
            ownedEdgeTables: [],
            nodeKinds: frozenNodeTypes.map((t) => t.name),
            edgeKinds: frozenEdgeRelations.map((e) => e.name),
        },

        uiHints: DEFAULT_UI_HINTS,

        // Tier 1 plugins automatically expose per-type and per-relation
        // MCP tools (store_<type>, list_<type>, connect_<relation>) via
        // `registerAutoTools`. The wrapping is thin — handlers call
        // graph.upsertNode / graph.listNodes / graph.addEdge directly,
        // skipping per-row reconnect (consistent with bulk ingest).
        registerTools(server: McpServer, ctx: PluginContext): void {
            registerAutoTools(server, ctx, manifest);
        },

        contributeNodeTypes(): Array<{ name: string; description: string }> {
            // Defensive copy on every call — callers may receive this
            // array, mutate it, and never realise they're poking the
            // plugin's internal state.
            return frozenNodeTypes.map((t) => ({ name: t.name, description: t.description }));
        },

        contributeEdgeRelations(): Array<{ name: string; description: string }> {
            return frozenEdgeRelations.map((e) => ({ name: e.name, description: e.description }));
        },
    };

    return synthetic;
}

/**
 * Determine whether a manifest is "Tier 1" — i.e. it should be loaded
 * via `manifestToPlugin` rather than by importing `lore.module`. The
 * rule: has a `lore.schema` block AND no `lore.module`. If both are
 * present the JS module wins (warn-and-use-module semantics).
 */
export function isTierOneManifest(manifest: PluginManifest): boolean {
    if (!manifest.lore) return false;
    if (manifest.lore.module) return false;
    if (!manifest.lore.schema) return false;
    return true;
}
