/**
 * localEmbeddingProvider.ts — Q2.2 slice 6a + slice 7.
 *
 * In-process EmbeddingProvider backed by HuggingFace Transformers.js.
 * Loads the configured Xenova model (default
 * `Xenova/all-MiniLM-L6-v2`, 384-d, mean-pooled, L2-normalized) on
 * first call and reuses the singleton for every subsequent embed.
 *
 * Why a singleton:
 *   The HF pipeline cold-loads the model file (~80MB MiniLM, ~120MB
 *   e5-small) and the WebGPU / WASM runtime; loading it twice would
 *   double daemon RAM and slow first-request latency. The class shares
 *   a module-scoped cache so constructing multiple instances (test
 *   harness, multi-store wiring) doesn't multiply the cost.
 *
 * Slice history:
 *   - pre-6a: VerbatimStore and DataplaneVectorStore each carried their
 *     own copy of the singleton + pipeline call.
 *   - 6a: extracted the duplicated code into this class behind the
 *     EmbeddingProvider interface (providers/types.ts).
 *   - 6b: OpenAICompatEmbeddingProvider sits beside this class for
 *     hosted-model deployments (BGE-M3 1024-d, OpenAI, etc.).
 *   - 7 (this slice): exposed `Xenova/multilingual-e5-small` as a
 *     first-class option (export + env opt-in). Same 384-d output,
 *     same pooling + normalization, but covers ~100 languages with
 *     stronger retrieval quality. Default left at MiniLM intentionally:
 *     existing operators have MiniLM cached on disk and reconnected
 *     vectors; flipping the default would force every existing
 *     install to download ~120MB on first daemon boot AND silently
 *     produce vectors that don't match their existing LanceDB rows.
 *     Operators wanting multilingual configure it explicitly via
 *     `LORE_LOCAL_EMBEDDING_MODEL=Xenova/multilingual-e5-small` (server
 *     factory) or by passing `{ modelId: MULTILINGUAL_E5_SMALL_MODEL_ID }`
 *     to the constructor. A future slice will add migration tooling
 *     (drop+rebuild `lore_verbatim`, modelId fingerprint check) to
 *     make flipping the default safe.
 */

// @ts-ignore — Local workspace linking lacks full Node16 exports declaration
import { pipeline } from '@huggingface/transformers';

import type { EmbeddingProvider } from './types.js';

/**
 * The default model used by the local provider when no override is
 * supplied. Kept as a public export so call sites that need to assert
 * the value (telemetry, schema versioning) can reference one constant.
 */
export const DEFAULT_LOCAL_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
/** Dimension of `DEFAULT_LOCAL_MODEL_ID`. */
export const DEFAULT_LOCAL_MODEL_DIM = 384;
/**
 * Slice 7: opt-in multilingual default. Same 384-d output as MiniLM
 * (so the LanceDB schema width is compatible) but covers ~100
 * languages. Constructing
 * `new LocalEmbeddingProvider({ modelId: MULTILINGUAL_E5_SMALL_MODEL_ID })`
 * — or setting `LORE_LOCAL_EMBEDDING_MODEL=Xenova/multilingual-e5-small`
 * in the server factory — selects this. NOTE: switching against an
 * existing graph silently invalidates retrieval quality (vectors
 * embed to a different space). Drop+rebuild `lore_verbatim` (full
 * reconnect pass) when you swap.
 */
export const MULTILINGUAL_E5_SMALL_MODEL_ID = 'Xenova/multilingual-e5-small';
/** Dimension of `MULTILINGUAL_E5_SMALL_MODEL_ID`. */
export const MULTILINGUAL_E5_SMALL_MODEL_DIM = 384;

/** Module-scoped pipeline cache — see "Why a singleton" above. */
let pipelineInstance: any = null;
let pipelineLoadingPromise: Promise<any> | null = null;

async function loadPipeline(modelId: string): Promise<any> {
    if (pipelineInstance) return pipelineInstance;
    if (!pipelineLoadingPromise) {
        pipelineLoadingPromise = pipeline('feature-extraction', modelId);
    }
    pipelineInstance = await pipelineLoadingPromise;
    return pipelineInstance;
}

/**
 * Test-only: drop the cached pipeline so a subsequent call reloads it.
 * Not part of the EmbeddingProvider contract; only used in tests that
 * exercise initialization paths.
 */
export function _resetLocalEmbeddingPipelineForTests(): void {
    pipelineInstance = null;
    pipelineLoadingPromise = null;
}

export interface LocalEmbeddingProviderOptions {
    /** HF model id; defaults to DEFAULT_LOCAL_MODEL_ID. */
    modelId?: string;
    /** Vector dimension; defaults to DEFAULT_LOCAL_MODEL_DIM. */
    dimension?: number;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
    public readonly modelId: string;
    public readonly dimension: number;

    constructor(opts: LocalEmbeddingProviderOptions = {}) {
        this.modelId = opts.modelId ?? DEFAULT_LOCAL_MODEL_ID;
        this.dimension = opts.dimension ?? DEFAULT_LOCAL_MODEL_DIM;
    }

    async initialize(): Promise<void> {
        await loadPipeline(this.modelId);
    }

    async embed(text: string): Promise<number[]> {
        const embedder = await loadPipeline(this.modelId);
        const output = await embedder(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data) as number[];
    }
}
