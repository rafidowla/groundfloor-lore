/**
 * cli/embedderCommands.ts — `lore embedder` family.
 *
 * User-driven embedder management. Replaces the silent auto-detect
 * at daemon boot with deliberate operator commands. Three subcommands:
 *
 *   lore embedder list
 *     Show the currently-active embedder + the registered alternatives.
 *
 *   lore embedder check
 *     Probe localhost for Ollama / LM Studio / llama.cpp / OpenAI.
 *     Report what's reachable + what models are available. Suggest a
 *     `lore embedder switch` command for any speed-up the operator could
 *     opt into.
 *
 *   lore embedder switch --to <name> [--apply] [--force]
 *     Stop the daemon (operator-driven), run the embedding migration,
 *     restart. The migration drops + rebuilds lore_verbatim under the
 *     new model so the vector space is consistent end-to-end.
 *
 * Naming convention for `<name>`:
 *   - `local-xenova-multilingual` — current default; multilingual e5-small via Wasm
 *   - `local-xenova-minilm` — English-only MiniLM via Wasm (smaller, faster on Wasm)
 *   - `ollama-<model>` — any model installed in local Ollama
 *   - `lmstudio-<model>` — LM Studio's loaded model
 *   - `llamacpp-<model>` — llama.cpp server's loaded model
 *   - `openai-<model>` — OpenAI cloud (requires LORE_OPENAI_API_KEY)
 *   - `custom` — operator-supplied --base-url + --model + --dim
 *
 * License: original work for groundfloor-lore.
 */

import path from 'path';
import { loreHome } from '../config/loreHome.js';
import {
    DEFAULT_LOCAL_MODEL_ID,
    DEFAULT_LOCAL_MODEL_DIM,
    MULTILINGUAL_E5_SMALL_MODEL_ID,
    MULTILINGUAL_E5_SMALL_MODEL_DIM,
    MINILM_L6_V2_MODEL_ID,
} from '../providers/localEmbeddingProvider.js';

interface OpenAICompatProbe {
    label: string;
    url: string;
    listEndpoint: string;
}

const OPENAI_COMPAT_PROBES: OpenAICompatProbe[] = [
    { label: 'ollama', url: 'http://127.0.0.1:11434/v1', listEndpoint: 'http://127.0.0.1:11434/api/tags' },
    { label: 'lmstudio', url: 'http://127.0.0.1:1234/v1', listEndpoint: 'http://127.0.0.1:1234/v1/models' },
    { label: 'llamacpp', url: 'http://127.0.0.1:8080/v1', listEndpoint: 'http://127.0.0.1:8080/v1/models' },
];

interface ProbeResult {
    label: string;
    url: string;
    reachable: boolean;
    embeddingModels: string[];
    error?: string;
}

async function probeEndpoint(probe: OpenAICompatProbe, timeoutMs: number = 1500): Promise<ProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const r = await fetch(probe.listEndpoint, { method: 'GET', signal: controller.signal });
        clearTimeout(timer);
        if (!r.ok) {
            return { label: probe.label, url: probe.url, reachable: false, embeddingModels: [], error: `HTTP ${r.status}` };
        }
        const data = await r.json() as { models?: Array<{ name?: string }>; data?: Array<{ id?: string }> };
        const names: string[] = [];
        if (Array.isArray(data.models)) for (const m of data.models) if (m.name) names.push(m.name);
        if (Array.isArray(data.data)) for (const m of data.data) if (m.id) names.push(m.id);
        // Filter to models whose name suggests they embed (rough heuristic;
        // real check would be to call /v1/embeddings with the model and see
        // if it responds). Avoids picking llama3.2 as an "embedder" in a
        // list that mixes chat + embedding models.
        const embeddingHints = ['embed', 'minilm', 'bge-', 'nomic', 'arctic', 'gte-', 'e5'];
        const embeddingModels = names.filter((n) =>
            embeddingHints.some((hint) => n.toLowerCase().includes(hint)),
        );
        return { label: probe.label, url: probe.url, reachable: true, embeddingModels };
    } catch (err) {
        clearTimeout(timer);
        return {
            label: probe.label,
            url: probe.url,
            reachable: false,
            embeddingModels: [],
            error: (err as Error).message,
        };
    }
}

/**
 * Resolve an embedder name to a concrete configuration:
 *   { kind: 'local' | 'openai-compat' | 'custom', modelId, dimension, baseUrl?, apiKey? }
 *
 * Returns null if the name doesn't resolve. Caller can use the registry
 * to print suggestions.
 */
interface EmbedderConfig {
    kind: 'local' | 'openai-compat';
    modelId: string;
    dimension: number;
    baseUrl?: string;
    apiKey?: string;
    label: string;
}

const REGISTERED_EMBEDDERS: Record<string, EmbedderConfig> = {
    'local-xenova-multilingual': {
        kind: 'local',
        modelId: MULTILINGUAL_E5_SMALL_MODEL_ID,
        dimension: MULTILINGUAL_E5_SMALL_MODEL_DIM,
        label: 'Xenova multilingual-e5-small (Wasm CPU; default for local mode)',
    },
    'local-xenova-minilm': {
        kind: 'local',
        modelId: MINILM_L6_V2_MODEL_ID,
        dimension: 384,
        label: 'Xenova all-MiniLM-L6-v2 (English-only; Wasm CPU)',
    },
};

/* ─── lore embedder list ─────────────────────────────────────── */

export async function embedderListCommand(_args: string[]): Promise<void> {
    const { readFingerprintOrLegacy } = await import('../engines/embeddingFingerprint.js');
    const basePath = loreHome();
    const fp = readFingerprintOrLegacy(basePath);

    console.log('');
    console.log('Active embedder (from on-disk fingerprint):');
    console.log(`  modelId:    ${fp.modelId}`);
    console.log(`  dimension:  ${fp.dimension}`);
    console.log('');
    console.log('Registered embedder names (use with `lore embedder switch --to <name>`):');
    for (const [name, cfg] of Object.entries(REGISTERED_EMBEDDERS)) {
        console.log(`  ${name.padEnd(34)} ${cfg.label}`);
    }
    console.log('');
    console.log('For an OpenAI-compatible endpoint (Ollama / LM Studio / llama.cpp / cloud):');
    console.log('  lore embedder switch --to <ollama-bge-m3 | lmstudio-... | custom> --apply');
    console.log('  See `lore embedder check` to discover what\'s reachable on this host.');
}

/* ─── lore embedder check ─────────────────────────────────────── */

export async function embedderCheckCommand(_args: string[]): Promise<void> {
    console.log('');
    console.log('Probing local embedder endpoints (1.5s timeout each)...');
    console.log('');
    const results = await Promise.all(OPENAI_COMPAT_PROBES.map((p) => probeEndpoint(p)));
    let foundFast = false;
    for (const r of results) {
        if (!r.reachable) {
            console.log(`  ${r.label.padEnd(10)} ${r.url.padEnd(40)} not reachable${r.error ? ` (${r.error})` : ''}`);
            continue;
        }
        foundFast = true;
        console.log(`  ${r.label.padEnd(10)} ${r.url.padEnd(40)} REACHABLE`);
        if (r.embeddingModels.length === 0) {
            console.log(`             no embedding-capable models detected; install one (e.g. \`ollama pull bge-m3\`)`);
        } else {
            console.log(`             embedding models: ${r.embeddingModels.join(', ')}`);
        }
    }
    console.log('');
    if (foundFast) {
        console.log('Speed-up available:');
        console.log('  Switch to one of the reachable accelerators with:');
        console.log('  lore embedder switch --to <name> --apply');
        console.log('');
        console.log('  Switching triggers a re-embed of every stored item. ~6 min on Ollama,');
        console.log('  ~1 min on most cloud APIs. Daemon must be stopped during the migration.');
    } else {
        console.log('No local accelerators detected. Lore is using the bundled Xenova-Wasm provider.');
        console.log('To get a ~50× reconnect speedup, install one of:');
        console.log('  - Ollama:    https://ollama.com  +  ollama pull bge-m3');
        console.log('  - LM Studio: https://lmstudio.ai  + load an embedding model');
        console.log('Then re-run `lore embedder check` to confirm the daemon can see it.');
    }
}

/* ─── lore embedder switch ─────────────────────────────────────── */

export async function embedderSwitchCommand(args: string[]): Promise<void> {
    const toIdx = args.indexOf('--to');
    const apply = args.includes('--apply');
    const force = args.includes('--force');

    const target = toIdx >= 0 ? args[toIdx + 1] : '';
    if (!target) {
        console.error('usage: lore embedder switch --to <name> [--apply] [--force]');
        console.error('       lore embedder switch --to custom --base-url <url> --model <id> --dim <n> [--api-key <k>] [--apply]');
        console.error('');
        console.error('Run `lore embedder list` to see registered names.');
        console.error('Run `lore embedder check` to see reachable accelerators on this host.');
        process.exit(1);
    }

    let cfg = REGISTERED_EMBEDDERS[target];
    if (!cfg) {
        // Recognise dynamic patterns: ollama-<model>, lmstudio-<model>, llamacpp-<model>, openai-<model>, custom
        if (target === 'custom') {
            const baseUrlIdx = args.indexOf('--base-url');
            const modelIdx = args.indexOf('--model');
            const dimIdx = args.indexOf('--dim');
            const apiKeyIdx = args.indexOf('--api-key');
            if (baseUrlIdx < 0 || modelIdx < 0 || dimIdx < 0) {
                console.error('--to custom requires --base-url <url> --model <id> --dim <n>');
                process.exit(1);
            }
            cfg = {
                kind: 'openai-compat',
                modelId: args[modelIdx + 1],
                dimension: Number.parseInt(args[dimIdx + 1], 10),
                baseUrl: args[baseUrlIdx + 1],
                apiKey: apiKeyIdx >= 0 ? args[apiKeyIdx + 1] : undefined,
                label: `custom OpenAI-compat (${args[modelIdx + 1]})`,
            };
        } else if (target.startsWith('ollama-')) {
            const modelName = target.slice('ollama-'.length);
            cfg = {
                kind: 'openai-compat',
                modelId: modelName,
                dimension: dimForKnownOllamaModel(modelName),
                baseUrl: 'http://127.0.0.1:11434/v1',
                label: `Ollama ${modelName}`,
            };
        } else if (target.startsWith('lmstudio-')) {
            const modelName = target.slice('lmstudio-'.length);
            const dimIdx = args.indexOf('--dim');
            if (dimIdx < 0) {
                console.error(`--to lmstudio-${modelName} also requires --dim <n> (LM Studio doesn't advertise dim)`);
                process.exit(1);
            }
            cfg = {
                kind: 'openai-compat',
                modelId: modelName,
                dimension: Number.parseInt(args[dimIdx + 1], 10),
                baseUrl: 'http://127.0.0.1:1234/v1',
                label: `LM Studio ${modelName}`,
            };
        } else if (target.startsWith('llamacpp-')) {
            const modelName = target.slice('llamacpp-'.length);
            const dimIdx = args.indexOf('--dim');
            if (dimIdx < 0) {
                console.error(`--to llamacpp-${modelName} also requires --dim <n>`);
                process.exit(1);
            }
            cfg = {
                kind: 'openai-compat',
                modelId: modelName,
                dimension: Number.parseInt(args[dimIdx + 1], 10),
                baseUrl: 'http://127.0.0.1:8080/v1',
                label: `llama.cpp ${modelName}`,
            };
        } else if (target.startsWith('openai-')) {
            const modelName = target.slice('openai-'.length);
            const dimIdx = args.indexOf('--dim');
            const apiKey = process.env.LORE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
            if (!apiKey) {
                console.error('--to openai-* requires LORE_OPENAI_API_KEY or OPENAI_API_KEY env var');
                process.exit(1);
            }
            cfg = {
                kind: 'openai-compat',
                modelId: modelName,
                dimension: dimIdx >= 0 ? Number.parseInt(args[dimIdx + 1], 10) : 1536,
                baseUrl: 'https://api.openai.com/v1',
                apiKey,
                label: `OpenAI ${modelName}`,
            };
        } else {
            console.error(`Unknown embedder name: ${target}`);
            console.error('Run `lore embedder list` for registered names.');
            process.exit(1);
        }
    }

    console.log('');
    console.log(`Switching active embedder to: ${cfg.label}`);
    console.log(`  modelId:    ${cfg.modelId}`);
    console.log(`  dimension:  ${cfg.dimension}`);
    if (cfg.baseUrl) console.log(`  baseUrl:    ${cfg.baseUrl}`);
    console.log(`  Mode:       ${apply ? 'APPLY (will drop + rebuild lore_verbatim)' : 'DRY-RUN (re-run with --apply to commit)'}`);
    console.log('');

    if (!apply) {
        console.log('Dry-run only. To actually switch, re-run with --apply.');
        console.log('');
        console.log('What will happen on --apply:');
        console.log('  1. Stop the daemon (operator must do this; this CLI cannot stop it for you)');
        console.log('  2. Drop the lore_verbatim table');
        console.log('  3. Re-embed every LoreNode + plugin contribution with the new model');
        console.log('  4. Write the new fingerprint');
        console.log('  5. Restart the daemon (operator must do this)');
        console.log('');
        console.log('Re-embed cost on this host: roughly 6 min for ~16k items via Ollama, ~25 min via Wasm.');
        return;
    }

    // Reuse the existing migrateEmbeddingModelCommand by setting env vars.
    // That command honours LORE_EMBEDDING_PROVIDER + LORE_EMBEDDING_BASE_URL +
    // LORE_EMBEDDING_MODEL etc. We construct the env in-process so the
    // subsequent migrate call sees them.
    if (cfg.kind === 'openai-compat') {
        process.env['LORE_EMBEDDING_PROVIDER'] = 'openai_compat';
        process.env['LORE_EMBEDDING_BASE_URL'] = cfg.baseUrl ?? '';
        process.env['LORE_EMBEDDING_MODEL'] = cfg.modelId;
        process.env['LORE_EMBEDDING_DIMENSION'] = String(cfg.dimension);
        if (cfg.apiKey) process.env['LORE_EMBEDDING_API_KEY'] = cfg.apiKey;
    } else {
        // local kind — clear remote config so the migrate command picks
        // LocalEmbeddingProvider.
        delete process.env['LORE_EMBEDDING_PROVIDER'];
        delete process.env['LORE_EMBEDDING_BASE_URL'];
        delete process.env['LORE_EMBEDDING_MODEL'];
        delete process.env['LORE_EMBEDDING_DIMENSION'];
        delete process.env['LORE_EMBEDDING_API_KEY'];
    }

    const { migrateEmbeddingModelCommand } = await import('./commands.js');
    const migrateArgs: string[] = ['--to', cfg.modelId, '--dim', String(cfg.dimension), '--apply'];
    if (force) migrateArgs.push('--force');
    await migrateEmbeddingModelCommand(migrateArgs);

    console.log('');
    console.log('Restart the daemon to pick up the new fingerprint:');
    console.log('  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.groundfloor.lore.plist  # macOS');
    console.log('  systemctl --user restart lore                                                    # linux');
}

/** Best-effort dim lookup for known Ollama embedding models. */
function dimForKnownOllamaModel(modelName: string): number {
    const base = modelName.split(':')[0];
    const map: Record<string, number> = {
        'all-minilm': 384,
        'nomic-embed-text': 768,
        'mxbai-embed-large': 1024,
        'snowflake-arctic-embed': 1024,
        'bge-m3': 1024,
    };
    return map[base] ?? 768;
}

/** Top-level dispatcher for `lore embedder <subcommand>`. */
export async function embedderCommand(args: string[]): Promise<void> {
    const sub = args[0];
    const rest = args.slice(1);
    switch (sub) {
        case 'list':
            return embedderListCommand(rest);
        case 'check':
            return embedderCheckCommand(rest);
        case 'switch':
            return embedderSwitchCommand(rest);
        default:
            console.error('usage: lore embedder <list | check | switch>');
            console.error('');
            console.error('  list    Show the active embedder + registered names.');
            console.error('  check   Probe local accelerators (Ollama / LM Studio / llama.cpp).');
            console.error('  switch  Change the active embedder. --apply triggers re-embed migration.');
            process.exit(1);
    }
}

// `path` is imported for future expansion (config file reads); silence the unused-var warning for now.
void path;
