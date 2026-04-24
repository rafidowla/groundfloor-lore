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
    llmProvider: string;
    workspaceAccount: string;
    plugin_history?: PluginHistoryEntry[];
    /**
     * Snapshot of `plugins` from the PREVIOUS successful boot. Used by
     * the orphan detector to find plugins the user removed since last run.
     * Written at the end of each successful boot.
     */
    plugins_last_boot?: string[];

    /**
     * Phase 2: Dual-path extraction routing. "local-byok" is the only
     * wired path; "def-cloud" is reserved and surfaced in Settings as
     * a greyed-out radio until the Groundfloor sign-in workflow ships.
     */
    extractionPath?: 'local-byok' | 'def-cloud';

    /**
     * Phase 2 / Phase 4: When true, Lore suppresses the Dataplane
     * telemetry health-ping. Stub today — the ping is not yet wired —
     * but persisted so Phase 4 can honor it on first implementation.
     */
    telemetryOptOut?: boolean;

    /**
     * V2.2 embedded-model upgrade (2026-04-20). When true, the
     * embedded LLM pipeline stays resident in memory for the daemon
     * lifetime (~1.2-1.5 GB RAM). When false (default), the pipeline
     * gets idle-unloaded after 3 minutes of no queries — freeing the
     * RAM when you're not actively chatting, at the cost of one
     * ~5-10s reload on next use. Recommended OFF on memory-constrained
     * laptops running Dataplane + IDE + browser alongside Lore.
     */
    keepEmbeddedModelHot?: boolean;

    /**
     * V2.2 chat auto-execute (2026-04-23). When true AND the active
     * LLM has toolCalling === 'native', any action-suggestion tokens
     * the model emits are auto-executed without the user clicking the
     * button. Audit log still records every execution. Only surfaces
     * in Settings when the active provider is native-tier (Anthropic
     * Claude 3.5+/4+, OpenAI GPT-4o/o-series); embedded Gemma 1B
     * stays on the click-to-confirm path regardless of this flag.
     * Default false — opt-in per user; small quality-of-life for
     * those who trust their BYOK model not to hallucinate action tokens.
     */
    autoExecuteChatActions?: boolean;

    /**
     * Q1.5 — analytical projection capability.
     *
     *   enabled: global master switch. When false, `analyze_graph`
     *            refuses with a friendly "disabled in Settings" message
     *            and no projection hooks are called.
     *   perPluginOptOut: active plugins whose projections are hidden.
     *            Lets a workspace use the developer plugin for code
     *            context while silencing its analytical surface (e.g.
     *            privacy-sensitive teams who don't want "symbols per
     *            file" queryable).
     *
     * Default: enabled with no opt-outs. Airplane-safe either way —
     * projections are local queries.
     */
    analyticalProjections?: {
        enabled: boolean;
        perPluginOptOut: string[];
    };

    /**
     * Q1.3 — local read-cache tier (in-proc LRU + TTL).
     *
     *   enabled: master switch. When false, the cache is constructed
     *            in pass-through mode — every read hits the graph.
     *            Kept for troubleshooting; off is never the recommended
     *            default because the cache is process-local and free.
     *   ttlSeconds: entry lifetime before the next read misses. Default
     *               60 seconds matches a user-session-level expectation:
     *               "a write I did is immediately visible; results I
     *               read go stale within the minute if nobody else
     *               touches them." Range clamped to 1..3600 at load.
     *   maxEntries: LRU ceiling. Default 500 — typical hot-path work
     *               repeats within that window (search + listNodes +
     *               getNode fanout during recall). Range 16..50_000.
     *
     * Environment override: LORE_CACHE_DISABLED=1 wins over the
     * setting and forces pass-through. Used by the benchmark harness
     * to get a clean cold baseline; available as an operator lever.
     *
     * Default: enabled with the numbers above. Airplane-safe — cache
     * is 100% in-proc; no network, no disk.
     */
    localCache?: {
        enabled: boolean;
        ttlSeconds: number;
        maxEntries: number;
    };

    /**
     * Q2.1 — Deployment mode switch (Path A consolidation, 2026-04-20).
     *
     *   'local' (default)  Single-user daemon on one workstation. Uses the
     *                      embedded Kùzu graph under the active workspace
     *                      directory, no Dataplane dependency required.
     *   'cloud'            Multi-tenant server mode. Boot REFUSES without
     *                      a Dataplane credential (keychain `dataplane`
     *                      account, or DATAPLANE_API_KEY env). Every
     *                      authenticated /api/* request must carry an
     *                      `X-Lore-Workspace` header identifying the
     *                      tenant workspace. Per-workspace graph routing
     *                      and cloud storage adapters (Arango, Qdrant/
     *                      Zilliz, Postgres) land in Q2.2 — Q2.1 ships
     *                      only the deployment-mode scaffolding.
     *
     * Env override: LORE_DEPLOYMENT_MODE=cloud wins over the config file
     * (useful for container images and launchd plists that pin the mode
     * without touching user config).
     */
    deploymentMode?: 'local' | 'cloud';
}

export const DEFAULT_CONFIG: LoreConfig = {
    plugins: ['developer'],
    pluginConfig: {},
    // Default to the embedded Gemma 3 1B (upgraded from Qwen 0.5B in
    // V2.2) so a fresh install chats out of the box with no API keys
    // or Ollama required. Users upgrade to Anthropic/OpenAI/Ollama
    // from Settings once they have them.
    llmProvider: 'embedded',
    workspaceAccount: 'local',
    extractionPath: 'local-byok',
    telemetryOptOut: false,
    // Idle-unload enabled by default — memory-friendly for laptops.
    keepEmbeddedModelHot: false,
    // Auto-execute OFF by default — user must opt in per session for
    // the BYOK-native tier. Embedded tier ignores this flag.
    autoExecuteChatActions: false,
    // Q1.5 — analytical projections default-on; opt-out empty. Toggled
    // via Settings once the Q1.6 canvas exposes a switch.
    analyticalProjections: {
        enabled: true,
        perPluginOptOut: [],
    },
    // Q1.3 — local in-proc LRU read cache, default-on. See
    // docs/cache-key-contract.md for the shape; shipped values match
    // the ones wired in LocalGraph's constructor defaults so disk
    // config and code defaults don't drift.
    localCache: {
        enabled: true,
        ttlSeconds: 60,
        maxEntries: 500,
    },
    // Q2.1 — Default to local mode. Fresh installs and existing users
    // stay on the embedded single-user daemon. Server/container images
    // flip to 'cloud' via env (LORE_DEPLOYMENT_MODE) or explicit config.
    deploymentMode: 'local',
};

/**
 * Q2.1 — Resolve the effective deployment mode.
 *
 * Precedence: env var > config file > DEFAULT_CONFIG ('local').
 * `LORE_DEPLOYMENT_MODE` accepts case-insensitive 'local' or 'cloud';
 * any other value logs a warning and is ignored (falls through to
 * config). Never throws — invalid config falls back to 'local' so a
 * typo in config.json doesn't brick the daemon.
 */
export function resolveDeploymentMode(config: LoreConfig): 'local' | 'cloud' {
    const envRaw = process.env['LORE_DEPLOYMENT_MODE'];
    if (envRaw) {
        const envLower = envRaw.trim().toLowerCase();
        if (envLower === 'local' || envLower === 'cloud') return envLower;
        console.error(`[Lore MCP] Ignoring invalid LORE_DEPLOYMENT_MODE=${envRaw} (expected 'local' or 'cloud')`);
    }
    return config.deploymentMode === 'cloud' ? 'cloud' : 'local';
}

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
     * Allowed keys: llmProvider, workspaceAccount, plugins, pluginConfig.
     * Rejects unknown keys silently (safe for versioned clients).
     */
    patch(update: Partial<LoreConfig>): LoreConfig {
        const current = this.read();
        const allowed: (keyof LoreConfig)[] = [
            'llmProvider',
            'workspaceAccount',
            'plugins',
            'pluginConfig',
            'plugin_history',
            'plugins_last_boot',
            'extractionPath',
            'telemetryOptOut',
            'keepEmbeddedModelHot',
            'autoExecuteChatActions',
            'analyticalProjections',
            'localCache',
            'deploymentMode',
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
