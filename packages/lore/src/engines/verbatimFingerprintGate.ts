/**
 * verbatimFingerprintGate.ts — the embedding-fingerprint policy applied when
 * a VerbatimStore opens, plus fingerprint stamping at table birth. Lives here
 * (not inline in verbatimStore.ts, which is over the file-size cap) so the
 * decision has one clearly-commented home.
 *
 * TWO POLICIES, selected by `strict`:
 *
 * NON-STRICT (default; every auto-selected / env-route provider). Today's
 * behaviour, unchanged: a model or dimension mismatch against the store's
 * fingerprint is LOGGED and the store opens anyway — an operator flipping
 * LORE_LOCAL_EMBEDDING_MODEL / _DEVICE must not have their daemon refuse to
 * boot; they get a loud warning plus the `lore migrate embedding-model`
 * command (see embeddingFingerprint.ts's header). The only addition is that a
 * dtype disagreement (both sides recorded one) is now also warned about —
 * still warn-only.
 *
 * STRICT (a host-injected provider — CreateLoreOptions.embeddingProvider).
 * Owner rule: "a mismatch must refuse to write, not write silently." ANY
 * disagreement between the provider and an existing store's fingerprint —
 * modelId, dimension, or dtype — throws EmbeddingFingerprintMismatchError at
 * open, before any write can happen. Additionally, a provider that declares
 * NO dtype is refused against a store whose fingerprint records one: the
 * store cannot be verified, so the host is told to declare it
 * (EmbeddingProvider.dtype / OpenAICompatEmbeddingProvider's `dtype` option).
 * The reverse — provider declares a dtype, store predates dtype recording —
 * is accepted on modelId + dimension, since nothing on disk contradicts it.
 *
 * HOW `strict` IS SET. Never inferred from the provider's shape (a plain
 * LocalEmbeddingProvider also has a dtype, so a shape heuristic would start
 * refusing ordinary local config flips). It is threaded explicitly from
 * `opts.embeddingProvider != null` (mcp/embeddingProviderSelection.ts) →
 * CreateVectorStoreOpts.injectedEmbeddingProvider / WorkspaceVerbatimResolver
 * → VerbatimStore's optional 3rd constructor arg (default false). Under
 * LORE_SEARCH_WORKER=1 the proxy forwards it to the child as
 * WORKER_ENV.STRICT_FINGERPRINT, so the child's own open refuses identically.
 *
 * Residual edge (pre-existing, not widened here): a table that exists with NO
 * fingerprint file (pre-fingerprint legacy store, or one created by the
 * prebuilt-row bulk path, which never stamps) is stamped with the current
 * provider's fingerprint on open, in both modes — there is nothing on disk to
 * compare against.
 */

import { checkCompatibility, readFingerprint, writeFingerprint } from './embeddingFingerprint.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { isEmbeddingDisabled } from '../providers/nullEmbeddingProvider.js';
import { log } from '../logger.js';

export type FingerprintMismatchKind = 'dimension' | 'model' | 'dtype' | 'dtype_undeclared';

/**
 * Thrown (strict mode only) when an injected embedding provider does not
 * match the fingerprint of the store it is opening. Nothing has been written
 * when this is thrown. `kind` is omitted only when the error was revived
 * from a search-worker child that did not report it.
 */
export class EmbeddingFingerprintMismatchError extends Error {
    readonly code = 'embedding_fingerprint_mismatch';
    constructor(message: string, readonly kind?: FingerprintMismatchKind, readonly basePath?: string) {
        super(message);
        this.name = 'EmbeddingFingerprintMismatchError';
    }
}

/** A provider's declared dtype, or undefined when it declares none. */
export function providerDtype(provider: EmbeddingProvider): string | undefined {
    const d = (provider as { dtype?: unknown }).dtype;
    return typeof d === 'string' && d.length > 0 ? d : undefined;
}

/** Best-effort fingerprint write (table birth / legacy stamp). Never throws.
 *  3.21 step 3(c) — a NullEmbeddingProvider fingerprint is never stamped: a
 *  'none' entry on disk would collide with — and corrupt — a real provider's
 *  fingerprint the next time embeddings are turned back on. */
export function stampFingerprint(basePath: string, provider: EmbeddingProvider, context: string): void {
    if (isEmbeddingDisabled(provider)) return;
    try {
        writeFingerprint(basePath, { modelId: provider.modelId, dimension: provider.dimension, dtype: providerDtype(provider) });
    } catch (err) {
        log.error(`[VerbatimStore] could not write fingerprint (${context}): ${(err as Error).message}`);
    }
}

const STRICT_HINT = '  Refusing to open: this store is opened with a host-injected embedding provider '
    + '(CreateLoreOptions.embeddingProvider), which is checked strictly — a mismatch is refused, never written. '
    + 'Use a provider matching the store, a different dataDir, or re-embed with `lore migrate embedding-model`.';

/**
 * Apply the fingerprint policy for a store being opened. `tableExists` is
 * whether `lore_verbatim` already exists (no table → nothing to check; the
 * fingerprint is stamped at first write). Throws only in strict mode.
 */
export function applyFingerprintOnOpen(
    basePath: string,
    tableExists: boolean,
    provider: EmbeddingProvider,
    strict: boolean,
): void {
    // 3.21 step 3(c) — a NullEmbeddingProvider never writes vectors, so
    // there is nothing on disk it could meaningfully be compared against —
    // skip the fingerprint check entirely rather than reporting a mismatch
    // (or, worse, stamping a 'none' fingerprint that would corrupt the next
    // real provider's compatibility check).
    if (isEmbeddingDisabled(provider)) return;
    if (!tableExists) return;
    const onDisk = readFingerprint(basePath);
    if (onDisk == null) {
        stampFingerprint(basePath, provider, 'legacy stamp');
        return;
    }
    const dtype = providerDtype(provider);
    const compat = checkCompatibility(basePath, { modelId: provider.modelId, dimension: provider.dimension, dtype });
    let kind: FingerprintMismatchKind | null = compat.mismatch;
    let message = compat.message;
    if (!kind && strict && onDisk.dtype && !dtype) {
        kind = 'dtype_undeclared';
        message = [
            `Embedding model fingerprint cannot be verified on ${basePath}:`,
            `  on-disk: model="${onDisk.modelId}", dim=${onDisk.dimension}, dtype=${onDisk.dtype}`,
            `  configured: model="${provider.modelId}", dim=${provider.dimension}, dtype=<not declared>`,
            `  Declare the provider's dtype (EmbeddingProvider.dtype, e.g. OpenAICompatEmbeddingProvider({ dtype: '${onDisk.dtype}' })) if it serves the same weights.`,
        ].join('\n');
    }
    if (!kind) return;
    if (!strict) {
        for (const line of message.split('\n')) log.error(`[VerbatimStore] ${line}`);
        return;
    }
    const full = `${message}\n${STRICT_HINT}`;
    for (const line of full.split('\n')) log.error(`[VerbatimStore] ${line}`);
    throw new EmbeddingFingerprintMismatchError(full, kind, basePath);
}
