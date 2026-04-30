/**
 * pickEmbeddingProvider.ts — Auto-detect best available embedder.
 *
 * Strategy (in order):
 *   1. Honour explicit env override (LORE_EMBEDDING_PROVIDER + companions)
 *   2. Try local Ollama at OLLAMA_HOST or http://127.0.0.1:11434
 *      - If reachable AND has an embedding-capable model, use it
 *      - Massively faster than Wasm (Metal/CUDA-accelerated, ~50-100x)
 *   3. Fall back to LocalEmbeddingProvider (Xenova-Wasm)
 *      - Always works, runs anywhere, but CPU-only and Wasm-interpreted
 *      - The current default — kept as the universal fallback
 *
 * The probe happens once at daemon startup. Result is logged in a
 * banner so the operator knows what's running and how fast to expect:
 *
 *   [Lore] Embedder: ollama (nomic-embed-text, 768-dim) at http://127.0.0.1:11434/v1
 *          ~1000 embeds/sec expected (Metal-accelerated on this host)
 *
 *   [Lore] Embedder: local Xenova multilingual-e5-small (384-dim, Wasm CPU)
 *          ~10-30 embeds/sec expected. For ~50× speedup install Ollama
 *          and `ollama pull nomic-embed-text`.
 *
 * License: original work for groundfloor-lore.
 */

import type { EmbeddingProvider } from './types.js';
import { LocalEmbeddingProvider } from './localEmbeddingProvider.js';
import { OpenAICompatEmbeddingProvider } from './openAICompatEmbeddingProvider.js';
import { readFingerprint } from '../engines/embeddingFingerprint.js';

/** Models Ollama typically exposes for embedding work, in preference order.
 *  Each entry: [model name, dim]. First-match wins.
 *  Operators can override with LORE_OLLAMA_EMBED_MODEL (any installed model). */
const OLLAMA_EMBED_PRIORITIES: ReadonlyArray<readonly [string, number]> = [
    ['nomic-embed-text', 768],          // 274MB, Apache 2.0, fast on CPU + Metal
    ['mxbai-embed-large', 1024],        // higher quality, slightly slower
    ['snowflake-arctic-embed', 1024],   // multilingual variant
    ['all-minilm', 384],                // tiny, very fast
    ['bge-m3', 1024],                   // multilingual
];

interface PickResult {
    provider: EmbeddingProvider;
    /** Human-readable banner line describing what we picked. */
    banner: string;
    /** Did we end up on the slow Wasm fallback? Surface in UI. */
    isFallback: boolean;
}

async function probeOllama(baseUrl: string, timeoutMs: number = 800): Promise<{ models: string[] } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
            method: 'GET',
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        const data = (await r.json()) as { models?: Array<{ name?: string }> };
        const models = (data.models ?? [])
            .map((m) => m.name ?? '')
            .filter((n) => n.length > 0);
        return { models };
    } catch {
        clearTimeout(timer);
        return null;
    }
}

/**
 * Auto-detect + construct the best available EmbeddingProvider.
 *
 * Falls back gracefully — never throws. If Ollama is configured but
 * unreachable, logs a warning and uses Xenova-Wasm (the operator can
 * tune env vars and restart).
 *
 * @param workspaceBasePath  When supplied, the picker reads the
 *   existing embedding fingerprint and prefers an Ollama model whose
 *   dim matches — avoids the "drop+rebuild LanceDB" cost on first
 *   restart after auto-detect lands. New installs (no fingerprint)
 *   get the higher-quality default (nomic-embed-text @ 768).
 */
export async function pickEmbeddingProvider(workspaceBasePath?: string): Promise<PickResult> {
    // 1. Explicit env override — operator chose a specific path.
    const explicitProvider = process.env.LORE_EMBEDDING_PROVIDER;
    if (explicitProvider === 'openai-compat' || explicitProvider === 'openai') {
        const baseUrl = process.env.LORE_OPENAI_BASE_URL || 'https://api.openai.com/v1';
        const modelId = process.env.LORE_OPENAI_MODEL || 'text-embedding-3-small';
        const dimension = Number(process.env.LORE_OPENAI_DIM || '1536');
        const apiKey = process.env.LORE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
        const provider = new OpenAICompatEmbeddingProvider({ baseUrl, modelId, dimension, apiKey });
        return {
            provider,
            banner: `[Lore] Embedder: openai-compat (${modelId}, ${dimension}-dim) at ${baseUrl}`,
            isFallback: false,
        };
    }

    // 2. Auto-detect Ollama unless caller explicitly said "local" / "xenova".
    if (explicitProvider !== 'local' && explicitProvider !== 'xenova') {
        const ollamaHost = process.env.OLLAMA_HOST || process.env.LORE_OLLAMA_HOST || 'http://127.0.0.1:11434';
        const probe = await probeOllama(ollamaHost);
        if (probe) {
            // Pick a model: env override first, then walk priority list.
            const envModel = process.env.LORE_OLLAMA_EMBED_MODEL;
            let chosen: { name: string; dim: number } | null = null;
            const installedNames = new Set(probe.models);

            // Ollama tags include version suffix e.g. "nomic-embed-text:latest";
            // match by base name.
            const baseNames = new Set(
                Array.from(installedNames).map((n) => n.split(':')[0]),
            );

            if (envModel) {
                if (baseNames.has(envModel.split(':')[0])) {
                    const dim = Number(process.env.LORE_OLLAMA_EMBED_DIM || '768');
                    chosen = { name: envModel, dim };
                }
            }

            // Dimension-compatibility check: if an existing LanceDB
            // fingerprint says dim=384, prefer an Ollama model that's
            // also 384-dim. Avoids the migrate-and-rebuild cost on
            // first restart after auto-detect lands.
            if (!chosen && workspaceBasePath) {
                const fp = readFingerprint(workspaceBasePath);
                if (fp) {
                    for (const [name, dim] of OLLAMA_EMBED_PRIORITIES) {
                        if (dim === fp.dimension && baseNames.has(name)) {
                            chosen = { name, dim };
                            console.error(`[Lore] Embedder: picked ${name} (${dim}-dim) to match existing LanceDB fingerprint at ${workspaceBasePath}`);
                            break;
                        }
                    }
                }
            }

            if (!chosen) {
                for (const [name, dim] of OLLAMA_EMBED_PRIORITIES) {
                    if (baseNames.has(name)) {
                        chosen = { name, dim };
                        break;
                    }
                }
            }

            if (chosen) {
                const provider = new OpenAICompatEmbeddingProvider({
                    baseUrl: `${ollamaHost.replace(/\/+$/, '')}/v1`,
                    modelId: chosen.name,
                    dimension: chosen.dim,
                });
                return {
                    provider,
                    banner: `[Lore] Embedder: Ollama (${chosen.name}, ${chosen.dim}-dim) at ${ollamaHost} — Metal/CUDA accelerated`,
                    isFallback: false,
                };
            }
            // Ollama running but no embedding model installed — surface as a hint.
            console.error(`[Lore] Ollama detected at ${ollamaHost} but no embedding model installed. Run: ollama pull nomic-embed-text  for ~50× faster reconnect. Falling back to Xenova-Wasm.`);
        }
    }

    // 3. Fallback — Xenova-Wasm. Always works, slow on CPU.
    const provider = new LocalEmbeddingProvider();
    return {
        provider,
        banner: `[Lore] Embedder: local Xenova ${provider.modelId} (${provider.dimension}-dim, Wasm CPU). For ~50× speedup install Ollama + 'ollama pull nomic-embed-text'.`,
        isFallback: true,
    };
}
