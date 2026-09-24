/**
 * embeddingProviderFactory.ts — the env-var route for selecting Lore's
 * embedding backend. Split out of services.ts (that file sits at the
 * 800-line hard cap; 3.21 step 3(c) added the `LORE_EMBEDDING_PROVIDER=none`
 * branch, which would have pushed it over) — `createEmbeddingProvider` is
 * re-exported from services.ts unchanged for every existing import site.
 */

import type { EmbeddingProvider } from '../providers/types.js';
import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';
import { OpenAICompatEmbeddingProvider } from '../providers/openAICompatEmbeddingProvider.js';
import { NullEmbeddingProvider } from '../providers/nullEmbeddingProvider.js';

/**
 * createEmbeddingProvider — Selects the embedding backend.
 *
 * Selection precedence (highest → lowest):
 *   0. LORE_EMBEDDING_PROVIDER=none → NullEmbeddingProvider (3.21 step 3(c)).
 *      Embeddings are OFF for this instance: every write/read path that
 *      touches the embedding provider is expected to check for this
 *      (isEmbeddingDisabled / modelId === 'none') and skip the vector leg
 *      cleanly, rather than calling this provider and catching its throw.
 *   1. LORE_EMBEDDING_PROVIDER=openai_compat → remote provider
 *      Requires LORE_EMBEDDING_BASE_URL, LORE_EMBEDDING_MODEL,
 *      LORE_EMBEDDING_DIMENSION. LORE_EMBEDDING_API_KEY optional.
 *   2. LORE_LOCAL_EMBEDDING_MODEL=<modelId> → local override
 *      Optional LORE_LOCAL_EMBEDDING_DIM (defaults to 384).
 *   3. (default) LocalEmbeddingProvider — Xenova/all-MiniLM-L6-v2.
 *
 * Reverted 2026-04-30: silent autodetection at boot was wrong design.
 * Embedder swaps belong in a deliberate `lore embedder switch` CLI
 * command (see commands.ts) that runs the migration as part of the swap.
 *
 * This is the ENV route; the higher-precedence host-injection route
 * (`createLore({ embeddingProvider: <instance> })`, including a
 * host-supplied `NullEmbeddingProvider`) short-circuits BEFORE this
 * function is even called — see mcp/embeddingProviderSelection.ts.
 */
export async function createEmbeddingProvider(
    overrides?: import('../providers/localEmbeddingProvider.js').LocalEmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
    const providerKind = (process.env['LORE_EMBEDDING_PROVIDER'] ?? '').trim().toLowerCase();

    if (providerKind === 'none' || providerKind === 'disabled' || providerKind === 'off') {
        console.error('[Lore MCP] Embedding provider: none (embeddings disabled — vector writes/reads are skipped)');
        return new NullEmbeddingProvider();
    }

    if (providerKind === 'openai_compat' || providerKind === 'compat' || providerKind === 'remote') {
        const baseUrl = process.env['LORE_EMBEDDING_BASE_URL'] ?? '';
        const modelId = process.env['LORE_EMBEDDING_MODEL'] ?? '';
        const dimRaw = process.env['LORE_EMBEDDING_DIMENSION'] ?? '';
        const apiKey = process.env['LORE_EMBEDDING_API_KEY'] ?? undefined;
        const dimension = Number.parseInt(dimRaw, 10);

        const missing: string[] = [];
        if (!baseUrl) missing.push('LORE_EMBEDDING_BASE_URL');
        if (!modelId) missing.push('LORE_EMBEDDING_MODEL');
        if (!Number.isInteger(dimension) || dimension <= 0) missing.push('LORE_EMBEDDING_DIMENSION');
        if (missing.length > 0) {
            throw new Error(
                `[Lore MCP] LORE_EMBEDDING_PROVIDER=${providerKind} requires: ${missing.join(', ')}`
            );
        }
        console.error(
            `[Lore MCP] Embedding provider: openai_compat (model=${modelId}, dim=${dimension}, base=${baseUrl})`
        );
        return new OpenAICompatEmbeddingProvider({ baseUrl, modelId, dimension, apiKey });
    }

    const localModelOverride = (process.env['LORE_LOCAL_EMBEDDING_MODEL'] ?? '').trim();
    const localDimRaw = (process.env['LORE_LOCAL_EMBEDDING_DIM'] ?? '').trim();
    // v1.1 (deferred item #3): operator opt-in for the ONNX execution
    // provider. Accepts 'cpu' | 'coreml' | 'webgpu' | 'cuda' | 'auto'.
    // Verify availability via /health.embeddingBackend.providers before
    // setting — the actual list of compiled-in EPs varies by platform.
    const localDeviceRaw = (process.env['LORE_LOCAL_EMBEDDING_DEVICE'] ?? '').trim().toLowerCase();
    const validDevices = new Set(['cpu', 'coreml', 'webgpu', 'cuda', 'auto', 'gpu']);
    const localDevice = localDeviceRaw && validDevices.has(localDeviceRaw)
        ? (localDeviceRaw as 'cpu' | 'coreml' | 'webgpu' | 'cuda' | 'auto' | 'gpu')
        : undefined;
    if (localDeviceRaw && !localDevice) {
        console.error(
            `[Lore MCP] LORE_LOCAL_EMBEDDING_DEVICE=${localDeviceRaw} not recognised; ignoring (valid: ${Array.from(validDevices).join(', ')})`
        );
    }

    // Programmatic overrides (from createLore({ embedding: ... })) take
    // precedence over env vars for the local provider path.
    const effectiveDevice = overrides?.device ?? localDevice;
    const effectiveModelId = overrides?.modelId ?? (localModelOverride || undefined);
    const effectiveDtype = overrides?.dtype;

    if (effectiveModelId) {
        const dim = overrides?.dimension ?? (localDimRaw ? Number.parseInt(localDimRaw, 10) : undefined);
        if (localDimRaw && !overrides?.dimension && (!Number.isInteger(dim) || (dim ?? 0) <= 0)) {
            throw new Error(
                `[Lore MCP] LORE_LOCAL_EMBEDDING_DIM must be a positive integer (got ${JSON.stringify(localDimRaw)})`
            );
        }
        const provider = new LocalEmbeddingProvider({
            modelId: effectiveModelId,
            ...(dim ? { dimension: dim } : {}),
            ...(effectiveDevice ? { device: effectiveDevice } : {}),
            ...(effectiveDtype ? { dtype: effectiveDtype } : {}),
        });
        console.error(
            `[Lore MCP] Embedding provider: local override (model=${provider.modelId}, dim=${provider.dimension}${effectiveDevice ? `, device=${effectiveDevice}` : ''})`
        );
        return provider;
    }

    const provider = new LocalEmbeddingProvider({
        ...(effectiveDevice ? { device: effectiveDevice } : {}),
        ...(effectiveDtype ? { dtype: effectiveDtype } : {}),
    });
    console.error(
        `[Lore MCP] Embedding provider: local (model=${provider.modelId}, dim=${provider.dimension}${effectiveDevice ? `, device=${effectiveDevice}` : ''})`
    );
    return provider;
}
