/**
 * localEmbeddingProvider.ts — Q2.2 slice 6a.
 *
 * In-process EmbeddingProvider backed by HuggingFace Transformers.js.
 * Loads `Xenova/all-MiniLM-L6-v2` (384-d, mean-pooled, L2-normalized) on
 * first call and reuses the singleton for every subsequent embed.
 *
 * Why a singleton:
 *   The HF pipeline cold-loads the model file (~80MB) and the WebGPU /
 *   WASM runtime; loading it twice would double daemon RAM and slow
 *   first-request latency. The class shares a module-scoped cache so
 *   constructing multiple instances (test harness, future multi-store
 *   wiring) doesn't multiply the cost.
 *
 * Slice history:
 *   - pre-6a: VerbatimStore and DataplaneVectorStore each carried their
 *     own copy of the singleton + pipeline call. Slice 6a extracted the
 *     duplicated code into this class behind the EmbeddingProvider
 *     interface (providers/types.ts) so:
 *       * Slice 6b can drop in a DataplaneEmbeddingProvider that hits
 *         the cloud BGE-M3 service without touching vector stores.
 *       * Slice 7 can swap the default model (multilingual-e5-small) by
 *         changing the constructor default — no vector-store edits.
 */

// @ts-ignore — Local workspace linking lacks full Node16 exports declaration
import { pipeline } from '@huggingface/transformers';

import type { EmbeddingProvider } from './types.js';

/**
 * The default model used by the local provider. Kept as a public export
 * so call sites that need to assert the value (telemetry, schema
 * versioning) can reference one constant.
 */
export const DEFAULT_LOCAL_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
/** Dimension of `DEFAULT_LOCAL_MODEL_ID`. */
export const DEFAULT_LOCAL_MODEL_DIM = 384;

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
