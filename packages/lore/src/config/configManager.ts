/**
 * configManager.ts — .lore/config.json read/write with safe defaults.
 *
 * Purpose:
 *   Single source of truth for the Lore V2 config document. Handles creation,
 *   reading, merging (PATCH), and V1→V2 migration.
 *
 * Config shape:
 *   {
 *     "llmProvider":    "anthropic" | "openai" | "ollama" | string
 *     "workspaceAccount": "local" | string
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

export interface LoreConfig {
    llmProvider: string;
    workspaceAccount: string;

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

    // TW-6b: `keepEmbeddedModelHot` and `autoExecuteChatActions` were
    // chat-only knobs (embedded LLM keep-hot toggle + chat action
    // auto-execute). They were removed with the chat surface — Lore Core
    // is API + MCP only, no LLM chat. See DECISIONS.md (2026-06-15).

    /**
     * Q1.5 — analytical projection capability.
     *
     *   enabled: global master switch. When false, `analyze_graph`
     *            refuses with a friendly "disabled in Settings" message
     *            and no projection hooks are called.
     *
     * Default: enabled. Airplane-safe either way — projections are
     * local queries.
     */
    // D2-hygiene-1: removed dead `perPluginOptOut` field — residue of the
    // plugin system deleted in v3.11.0; nothing reads it.
    analyticalProjections?: {
        enabled: boolean;
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
     *   'embedded'         In-process library mode (W3-EMBEDDED-MODE). Builds
     *                      the SAME local Kùzu/LanceDB substrates as 'local'
     *                      but opens NO transport (no stdio, no HTTP port) and
     *                      registers NO signal handlers — the embedding host
     *                      owns the lifecycle and calls `dispose()` explicitly.
     *                      Publisher/config-time only; never runtime-detected.
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
    deploymentMode?: 'local' | 'cloud' | 'embedded' | 'arcade';

    /**
     * M5 — AI capability tier for the end-user app.
     *
     * 'lite'     No local LLM. Graph, recall, search, heuristic Today cards.
     * 'basic'    1-3B model. Chat, summaries, todo extraction.
     * 'standard' 7-8B model. Quality chat, drafts.
     * 'powerful' 70B or OS-native. Best local quality.
     * 'hybrid'   Local retrieval + user-supplied cloud API key (BYOK).
     *
     * Default 'lite' — safe for hardware probe not yet run. The first-run
     * onboarding wizard (M7) calls GET /api/diagnostic/hardware and upgrades
     * this to the recommended tier automatically.
     */
    aiTier?: 'lite' | 'basic' | 'standard' | 'powerful' | 'hybrid';

    /**
     * Per-workspace Ollama model override. When set, this model name is
     * used instead of the dispatcher's hardcoded default
     * (DEFAULT_MODELS.ollama in llmDispatch.ts). Format matches `ollama list`
     * output, e.g. "llama3.1:8b", "qwen3-coder:30b", "mistral-nemo:12b".
     *
     * When unset (the common case), behavior is identical to before this
     * field existed — the dispatcher falls back to its default. Workspaces
     * with no preference keep working unchanged.
     *
     * Added 2026-05-17 so individual workspaces can pin a different
     * Ollama model than the daemon-wide default without code changes.
     */
    ollamaModel?: string;
}

export const DEFAULT_CONFIG: LoreConfig = {
    // Default to the embedded Gemma 3 1B (upgraded from Qwen 0.5B in
    // V2.2) so a fresh install chats out of the box with no API keys
    // or Ollama required. Users upgrade to Anthropic/OpenAI/Ollama
    // from Settings once they have them.
    llmProvider: 'embedded',
    workspaceAccount: 'local',
    extractionPath: 'local-byok',
    telemetryOptOut: false,
    // Q1.5 — analytical projections default-on; opt-out empty. Toggled
    // via Settings once the Q1.6 canvas exposes a switch.
    // D2-hygiene-1: `perPluginOptOut` default dropped along with the field.
    analyticalProjections: {
        enabled: true,
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
    // M5 — Default to lite until the hardware probe runs (first-run wizard
    // or manual Settings change upgrades this). Safe fallback: no LLM.
    aiTier: 'lite',
};

/**
 * Q2.1 / W3-EMBEDDED-MODE — Resolve the effective deployment mode.
 *
 * Precedence: explicit createLore() opt > LORE_DEPLOYMENT_MODE env > config
 * file > DEFAULT_CONFIG ('local'). This function owns the lower three rungs
 * (env > config > 'local'); the explicit-opt rung is applied by the
 * createLore() caller before falling through here. The CLI `--mode=...`
 * flag is stripped in `cli/index.ts` and written to `LORE_DEPLOYMENT_MODE`
 * before any subcommand runs, so this function reads it through the env path
 * uniformly.
 *
 * `LORE_DEPLOYMENT_MODE` accepts case-insensitive 'local', 'cloud',
 * 'embedded', or 'arcade' (the publisher-selectable modes); any other value
 * logs a warning and is ignored (falls through to config). 'embedded' is a
 * publisher/config-time choice — NOT a runtime auto-detect. 'arcade' is the
 * db-per-app ArcadeDB cloud backend (spike/arcadedb-multitenant): tenant
 * graph+vector live in one ArcadeDB database per customer-app, while the
 * relational lane (outbox/migrations/audit/auth registry) stays daemon-local
 * SQLite/JSONL exactly as in local mode. Never throws — invalid config falls
 * back to 'local' so a typo in config.json doesn't brick the daemon.
 */
export function resolveDeploymentMode(config: LoreConfig): 'local' | 'cloud' | 'embedded' | 'arcade' {
    const envRaw = process.env['LORE_DEPLOYMENT_MODE'];
    if (envRaw) {
        const envLower = envRaw.trim().toLowerCase();
        if (envLower === 'local' || envLower === 'cloud' || envLower === 'embedded' || envLower === 'arcade') return envLower;
        console.error(`[Lore MCP] Ignoring invalid LORE_DEPLOYMENT_MODE=${envRaw} (expected 'local', 'cloud', 'embedded', or 'arcade')`);
    }
    if (config.deploymentMode === 'cloud') return 'cloud';
    if (config.deploymentMode === 'embedded') return 'embedded';
    if (config.deploymentMode === 'arcade') return 'arcade';
    return 'local';
}

export class ConfigManager {
    private readonly configPath: string;
    private cache: LoreConfig | null = null;

    constructor(loreDir: string) {
        this.configPath = path.join(loreDir, 'config.json');
    }

    /**
     * read — Load the config from disk. Creates a default on first access.
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
     * Allowed keys: llmProvider, workspaceAccount, etc.
     * Rejects unknown keys silently (safe for versioned clients).
     */
    patch(update: Partial<LoreConfig>): LoreConfig {
        const current = this.read();
        const allowed: (keyof LoreConfig)[] = [
            'llmProvider',
            'workspaceAccount',
            'extractionPath',
            'telemetryOptOut',
            'analyticalProjections',
            'localCache',
            'deploymentMode',
            'aiTier',
            'ollamaModel',
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
