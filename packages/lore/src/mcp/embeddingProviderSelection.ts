/**
 * embeddingProviderSelection.ts — picks the ONE EmbeddingProvider a Lore
 * instance uses everywhere it embeds (boot vector store, per-workspace
 * verbatim resolver, embed queue, bulk-loader dimension, recall, and the
 * search worker's parentEmbedder). Split out of mcp/server.ts (over the
 * file-size cap) for feat/injected-embedding-provider.
 *
 * Selection precedence (highest → lowest):
 *   0. `CreateLoreOptions.embeddingProvider` — a host-injected provider.
 *      Used as-is; Lore constructs no provider of its own and never loads its
 *      local ONNX pipeline for this instance. Also switches the instance's
 *      stores to STRICT fingerprint checking (verbatimFingerprintGate.ts).
 *   1. LORE_EMBEDDING_PROVIDER=openai_compat → remote provider.
 *   2. LORE_LOCAL_EMBEDDING_MODEL=<modelId> → local override.
 *   3. (default) LocalEmbeddingProvider.
 * Steps 1-3 are `createEmbeddingProvider()` in services.ts (the env route for
 * hosts that configure via environment instead of code), applied with
 * `opts.embedding` overrides — unchanged, and only reached when step 0 is
 * absent.
 *
 * W2-CORE-SPLIT: selection runs inside createLore(), so importing the
 * library never triggers an embedding-provider load.
 */

import { createEmbeddingProvider } from './services.js';
import type { EmbeddingProvider } from '../providers/types.js';
import type { LocalEmbeddingProviderOptions } from '../providers/localEmbeddingProvider.js';

/** The injection half of CreateLoreOptions (extended by it in server.ts). */
export interface EmbeddingInjectionOptions {
    /**
     * Inject a fully-constructed EmbeddingProvider, bypassing Lore's own
     * provider construction (createEmbeddingProvider / the
     * LORE_EMBEDDING_PROVIDER env route) entirely. Used everywhere this
     * instance embeds (boot store, workspace resolver, embed queue, bulk
     * loader, recall, search-worker parent embedding). Omitted → `embedding`
     * overrides / env auto-detection, today's behaviour unchanged; when both
     * are present this field wins.
     *
     * An injected provider is checked STRICTLY against each store's on-disk
     * embedding fingerprint: any modelId / dimension / dtype mismatch makes
     * opening the store throw EmbeddingFingerprintMismatchError instead of
     * writing. Declare `dtype` on the provider (EmbeddingProvider.dtype) when
     * it serves the same weights as a local model, so fingerprints match.
     */
    embeddingProvider?: EmbeddingProvider;
}

export interface SelectedEmbeddingProvider {
    embeddingProvider: EmbeddingProvider;
    /** True only when the host injected the provider — drives strict fingerprint checks. */
    injectedEmbeddingProvider: boolean;
}

export async function selectEmbeddingProvider(
    opts: EmbeddingInjectionOptions & { embedding?: LocalEmbeddingProviderOptions },
): Promise<SelectedEmbeddingProvider> {
    if (opts.embeddingProvider) {
        return { embeddingProvider: opts.embeddingProvider, injectedEmbeddingProvider: true };
    }
    return { embeddingProvider: await createEmbeddingProvider(opts.embedding), injectedEmbeddingProvider: false };
}
