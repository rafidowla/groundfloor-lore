/**
 * registry.ts — Plugin loader, validator, and lifecycle coordinator.
 *
 * Responsibilities:
 *   1. Load all built-in plugins by name (config.plugins[]).
 *   2. Boot-time collision check — reject startup if two active plugins
 *      claim overlapping Kùzu table names.
 *   3. Orphan detection — if a plugin was active in the prior boot but
 *      is no longer listed, surface a prompt. Blocks /api/* until the
 *      user resolves via Keep / Drop / Re-enable (Option C per the V2 plan).
 *   4. Telemetry fan-out (Phase 4+).
 *
 * Plugin discovery: Phase 1 hard-codes the known plugins map. Third-party
 * plugins (loaded from npm) are deferred to a later phase.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ILorePlugin, PluginContext, PluginGraphContext } from './types.js';
import type { ConfigManager, LoreConfig } from '../config/configManager.js';
import type { PluginHistoryEntry } from '../config/configManager.js';
import { developerPlugin } from './developer/index.js';

/** Hard-coded plugin catalog. Extend here to add a new plugin. */
const BUILTIN_PLUGINS: Record<string, ILorePlugin> = {
    developer: developerPlugin,
};

/**
 * OrphanDecision — User's response to an orphan-detection prompt.
 *   - 'keep'      : leave tables on disk, do nothing (reversible)
 *   - 'drop'      : drop tables. Server requires the literal string 'DROP'
 *                   in the payload to confirm (UI modal enforces same).
 *   - 'reenable'  : add the plugin back to config.plugins[]
 */
export type OrphanDecision = 'keep' | 'drop' | 'reenable';

export interface OrphanState {
    orphans: string[];
    /** true when at least one orphan is pending a decision. /api/* is blocked. */
    blocking: boolean;
}

export class PluginRegistry {
    private readonly loaded = new Map<string, ILorePlugin>();
    private orphanState: OrphanState = { orphans: [], blocking: false };

    constructor(
        private readonly configManager: ConfigManager,
        private readonly knownPlugins: Record<string, ILorePlugin> = BUILTIN_PLUGINS,
    ) {}

    /**
     * boot — Run collision checks, orphan detection, and load the active set.
     * Returns the loaded plugins in activation order.
     *
     * Throws on collision; collision is a hard boot error (core can't safely
     * run with two plugins fighting over the same table).
     */
    boot(): ILorePlugin[] {
        const config = this.configManager.read();
        const prevPlugins = new Set(config.plugins_last_boot ?? []);
        const currentPlugins = new Set(config.plugins);
        const history = config.plugin_history ?? [];

        // Latest decision per plugin (used to suppress re-prompts after
        // the user already chose Keep/Drop/Reenable).
        const latestDecision = new Map<string, PluginHistoryEntry['decision']>();
        for (const entry of history) latestDecision.set(entry.plugin, entry.decision);

        // Orphan = plugin loaded last boot that isn't active this boot, and
        // doesn't already have a resolved history entry for this removal.
        // 'dropped' and 'kept' both silence the prompt — user already chose.
        // 'reenabled' doesn't silence: reenable followed by another removal
        // is a fresh orphan event.
        const orphans: string[] = [];
        for (const plugin of prevPlugins) {
            if (currentPlugins.has(plugin)) continue;
            const decision = latestDecision.get(plugin);
            if (decision === 'dropped' || decision === 'kept') continue;
            orphans.push(plugin);
        }
        this.orphanState = { orphans, blocking: orphans.length > 0 };

        // Load all active plugins
        for (const name of config.plugins) {
            const plugin = this.knownPlugins[name];
            if (!plugin) {
                throw new Error(`Unknown plugin "${name}". Available: ${Object.keys(this.knownPlugins).join(', ')}`);
            }
            this.loaded.set(name, plugin);
        }

        this.assertNoTableCollisions();

        // Persist the loaded set as "last boot" so the next startup can
        // compare. Skip when blocking on an orphan decision — don't overwrite
        // the history until the user has resolved.
        if (!this.orphanState.blocking) {
            this.configManager.patch({ plugins_last_boot: config.plugins });
        }

        return Array.from(this.loaded.values());
    }

    /**
     * registerTools — Invoke each active plugin's registrar against the
     * given McpServer instance. Called per-session in HTTP mode.
     */
    registerTools(server: McpServer, ctx: PluginContext): void {
        for (const plugin of this.loaded.values()) {
            plugin.registerTools(server, ctx);
        }
    }

    /**
     * V2.1 / Option C — Run each active plugin's `registerSchema` hook.
     * Called once at boot after the core graph finishes its own
     * initialize(). Plugins issue CREATE TABLE IF NOT EXISTS for their
     * own node/rel tables. Throws on any failure (bad schema = fatal).
     */
    async registerSchemas(ctx: PluginGraphContext): Promise<void> {
        for (const plugin of this.loaded.values()) {
            if (typeof plugin.registerSchema === 'function') {
                await plugin.registerSchema(ctx);
            }
        }
    }

    isActive(pluginName: string): boolean {
        return this.loaded.has(pluginName);
    }

    /** Iterate active plugins in activation order. */
    active(): ILorePlugin[] {
        return Array.from(this.loaded.values());
    }

    /** Combined node type enum across active plugins + the base schema. */
    collectNodeTypes(): string[] {
        return Array.from(
            new Set(
                Array.from(this.loaded.values()).flatMap((p) => p.nodeTypes),
            ),
        );
    }

    collectEdgeRelations(): string[] {
        return Array.from(
            new Set(
                Array.from(this.loaded.values()).flatMap((p) => p.edgeRelations),
            ),
        );
    }

    getOrphanState(): OrphanState {
        return { ...this.orphanState };
    }

    /**
     * resolveOrphan — User responded to the orphan prompt. Persist the
     * decision under plugin_history and unblock /api/* if no orphans remain.
     *
     * 'drop' is handled by the caller (server.ts) after this method records
     * the decision — the actual Kùzu table drop stays out of the registry
     * to keep this module free of engine dependencies.
     */
    resolveOrphan(plugin: string, decision: OrphanDecision): LoreConfig {
        const config = this.configManager.read();
        const history: PluginHistoryEntry[] = config.plugin_history ?? [];

        const mappedDecision: PluginHistoryEntry['decision'] =
            decision === 'keep' ? 'kept' : decision === 'drop' ? 'dropped' : 'reenabled';

        history.push({
            plugin,
            removed_at: new Date().toISOString(),
            decision: mappedDecision,
        });

        // On reenable: add back to plugins[] (deduped).
        const plugins = decision === 'reenable'
            ? Array.from(new Set([...config.plugins, plugin]))
            : config.plugins;

        const next = this.configManager.patch({ plugin_history: history, plugins });

        this.orphanState.orphans = this.orphanState.orphans.filter((o) => o !== plugin);
        this.orphanState.blocking = this.orphanState.orphans.length > 0;
        return next;
    }

    private assertNoTableCollisions(): void {
        const owner = new Map<string, string>();
        for (const plugin of this.loaded.values()) {
            for (const table of plugin.ownedTables) {
                const prior = owner.get(table);
                if (prior) {
                    throw new Error(
                        `Plugin collision: table "${table}" is claimed by both "${prior}" and "${plugin.name}". ` +
                        `Deactivate one in .lore/config.json.`,
                    );
                }
                owner.set(table, plugin.name);
            }
        }
    }
}
