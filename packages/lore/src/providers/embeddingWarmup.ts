/**
 * embeddingWarmup.ts — non-fatal embedding-model warm-up for store open.
 *
 * Stores used to `await embeddingProvider.initialize()` at open, so a
 * one-off model-cache download failure (e.g. undici ETIMEDOUT reaching
 * Hugging Face) failed the whole open. Everything a store needs from the
 * provider at open is static metadata (`modelId`, `dimension`, `dtype` —
 * the fingerprint gate and index schema use only those), so the warm-up is
 * just a cache-priming optimization and its failure is survivable.
 *
 * On failure: one warning, provider left uninitialized. The next call that
 * needs an embedding re-runs the load (the pipeline cache drops rejected
 * entries, see localEmbeddingProvider.ts) and, if it fails again, throws a
 * clear `EmbedModelUnavailableError` (modelCache.ts) naming the fix.
 */

import { log } from '../logger.js';
import { loreHomePath } from '../config/loreHome.js';
import { EmbedModelUnavailableError } from './modelCache.js';
import type { EmbeddingProvider } from './types.js';

/** Best-effort warm-up of `provider`; never throws. `site` names the caller
 *  (e.g. 'verbatimStore') for the warning. Returns true when warm. */
export async function warmEmbeddingProvider(provider: Pick<EmbeddingProvider, 'initialize' | 'modelId' | 'dtype'>, site: string): Promise<boolean> {
    try {
        await provider.initialize();
        return true;
    } catch (err) {
        // EmbedModelUnavailableError already names model, dtype, cache dir,
        // missing file and fix; anything else (corrupt model, ORT load
        // failure) gets that context added here.
        const detail = err instanceof EmbedModelUnavailableError
            ? err.message
            : `embedding model ${provider.modelId} (dtype ${provider.dtype ?? 'default'}, cache ${loreHomePath('models')}) failed to load: ${err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)}. Fix: run "lore models fetch-embedding" with network access.`;
        log.warn(`${site}: embedding model warm-up failed; opening anyway, the model load is retried by a later embed. ${detail}`);
        return false;
    }
}
