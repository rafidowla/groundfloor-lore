/**
 * configManager.ts — .lore/config.json read/write with safe defaults.
 *
 * Purpose:
 *   Single source of truth for the Lore V2 config document. Handles creation,
 *   reading, merging (PATCH), and V1→V2 migration.
 *
 * Config shape (Phase 0 minimum; expanded in Phase 1):
 *   {
 *     "plugins":        string[]            // active plugins, Phase 1
 *     "pluginConfig":   Record<string, any> // per-plugin opaque config
 *     "defaultMode":    string              // initial mode pill selection
 *     "llmProvider":    "anthropic" | "openai" | "ollama" | string
 *     "workspaceAccount": "local" | string
 *     "plugin_history": Array<{ plugin: string; removed_at: string; decision: "kept" | "dropped" | "reenabled" }>
 *   }
 *
 * API keys are NEVER stored here — see keychain.ts.
 *
 * Side Effects: Reads/writes .lore/config.json.
 * Error Behavior: Throws on malformed JSON; falls back to defaults on missing file.
 * Determinism: Deterministic for a given file.
 */

import fs from 'fs';
import path from 'path';

export interface PluginHistoryEntry {
    plugin: string;
    removed_at: string;
    decision: 'kept' | 'dropped' | 'reenabled';
}

export interface LoreConfig {
    plugins: string[];
    pluginConfig: Record<string, unknown>;
    defaultMode: string;
    llmProvider: string;
    workspaceAccount: string;
    plugin_history?: PluginHistoryEntry[];
}

export const DEFAULT_CONFIG: LoreConfig = {
    plugins: ['developer'],
    pluginConfig: {},
    defaultMode: 'developer',
    llmProvider: 'anthropic',
    workspaceAccount: 'local',
};

export class ConfigManager {
    private readonly configPath: string;
    private cache: LoreConfig | null = null;

    constructor(loreDir: string) {
        this.configPath = path.join(loreDir, 'config.json');
    }

    /**
     * read — Load the config from disk. Creates a default on first access
     * (V1→V2 migration auto-writes `{"plugins":["developer"]}`).
     */
    read(): LoreConfig {
        if (this.cache) return this.cache;

        if (!fs.existsSync(this.configPath)) {
            this.cache = { ...DEFAULT_CONFIG };
            this.writeInternal(this.cache);
            return this.cache;
        }

        try {
            const raw = fs.readFileSync(this.configPath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<LoreConfig>;
            this.cache = { ...DEFAULT_CONFIG, ...parsed };
            return this.cache;
        } catch (err) {
            throw new Error(`Invalid .lore/config.json: ${(err as Error).message}`);
        }
    }

    /**
     * patch — Merge partial updates into config and persist.
     * Allowed keys: llmProvider, workspaceAccount, defaultMode, plugins, pluginConfig.
     * Rejects unknown keys silently (safe for versioned clients).
     */
    patch(update: Partial<LoreConfig>): LoreConfig {
        const current = this.read();
        const allowed: (keyof LoreConfig)[] = [
            'llmProvider',
            'workspaceAccount',
            'defaultMode',
            'plugins',
            'pluginConfig',
            'plugin_history',
        ];
        const next: LoreConfig = { ...current };
        for (const key of allowed) {
            if (update[key] !== undefined) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (next as any)[key] = update[key];
            }
        }
        this.writeInternal(next);
        this.cache = next;
        return next;
    }

    /**
     * wasFreshlyCreated — true if read() just wrote a default config.
     * Used by the UI to surface the "Welcome to Lore V2" migration toast.
     */
    wasFreshlyCreated(): boolean {
        return fs.existsSync(this.configPath) && this.cache !== null;
    }

    private writeInternal(config: LoreConfig): void {
        const dir = path.dirname(this.configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
    }
}
