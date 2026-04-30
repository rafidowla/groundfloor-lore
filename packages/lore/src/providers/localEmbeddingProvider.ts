/**
 * localEmbeddingProvider.ts — Q2.2 slice 6a + slice 7 + post-7 default flip.
 *
 * In-process EmbeddingProvider backed by HuggingFace Transformers.js.
 * Loads the configured Xenova model (default
 * `Xenova/multilingual-e5-small`, 384-d, mean-pooled, L2-normalized)
 * on first call and reuses the singleton for every subsequent embed.
 *
 * Why a singleton:
 *   The HF pipeline cold-loads the model file (~120MB e5-small, ~80MB
 *   MiniLM) and the WebGPU / WASM runtime; loading it twice would
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
 *   - 7: exposed `Xenova/multilingual-e5-small` as a first-class
 *     option (export + env opt-in). Same 384-d output, same pooling +
 *     normalization, but covers ~100 languages with stronger retrieval
 *     quality. Default left at MiniLM at the time to avoid forcing
 *     every existing install to redownload + silently invalidate
 *     their existing LanceDB vectors.
 *   - post-7 (this change): default flipped to e5-small now that the
 *     migration tool from PR #30 (`lore migrate embedding-model`)
 *     exists. New installs get multilingual retrieval out of the box.
 *     Existing installs see a startup warning from the fingerprint
 *     check until they run the migration; the warning is intentionally
 *     non-fatal so the daemon doesn't refuse to start mid-upgrade.
 *     `Xenova/all-MiniLM-L6-v2` remains exported as
 *     `MINILM_L6_V2_MODEL_ID` for operators who explicitly want the
 *     English-only model (lower RAM, faster embed).
 */

// @ts-ignore — Local workspace linking lacks full Node16 exports declaration
import { pipeline } from '@huggingface/transformers';

import type { EmbeddingProvider } from './types.js';

/**
 * The default model used by the local provider when no override is
 * supplied. Kept as a public export so call sites that need to assert
 * the value (telemetry, schema versioning) can reference one constant.
 *
 * Post-7 flip: was `Xenova/all-MiniLM-L6-v2` until the migration tool
 * landed in PR #30 (`engines/migrateEmbeddingModel.ts`). New installs
 * now get multilingual retrieval by default. Existing installs see
 * a non-fatal fingerprint-mismatch warning on daemon start until they
 * run `lore migrate embedding-model --to Xenova/multilingual-e5-small
 * --apply`.
 */
export const DEFAULT_LOCAL_MODEL_ID = 'Xenova/multilingual-e5-small';
/** Dimension of `DEFAULT_LOCAL_MODEL_ID`. */
export const DEFAULT_LOCAL_MODEL_DIM = 384;

/**
 * Slice 7 alias retained for back-compat. Equal to
 * `DEFAULT_LOCAL_MODEL_ID` after the post-7 flip — kept as a separate
 * export so external code that imports the constant by name (telemetry
 * dashboards, plugin manifests, third-party scaffolds) doesn't break.
 */
export const MULTILINGUAL_E5_SMALL_MODEL_ID = 'Xenova/multilingual-e5-small';
/** Dimension of `MULTILINGUAL_E5_SMALL_MODEL_ID`. */
export const MULTILINGUAL_E5_SMALL_MODEL_DIM = 384;

/**
 * The pre-flip default. Exposed so operators who explicitly want the
 * English-only model (lower RAM ~80MB vs ~120MB, faster embed by ~25%
 * on cold cache) can configure it without typing the magic string.
 *
 *   new LocalEmbeddingProvider({ modelId: MINILM_L6_V2_MODEL_ID })
 *   LORE_LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
 *
 * Same 384-d width as the new default; switching against an existing
 * graph still requires `lore migrate embedding-model` because the
 * vectors live in different spaces.
 */
export const MINILM_L6_V2_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
/** Dimension of `MINILM_L6_V2_MODEL_ID`. */
export const MINILM_L6_V2_MODEL_DIM = 384;

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

/**
 * Detect e5-family models. The intfloat/e5 family (and Xenova mirrors)
 * are *asymmetric*: queries and documents are embedded in different
 * sub-regions of the space and cosine similarity only works when the
 * caller prepends "query: " or "passage: " before tokenizing. Without
 * the prefixes the model still produces 384-d vectors, but recall
 * scores collapse to near-random.
 *
 * This regex is intentionally permissive — matches "e5-small",
 * "e5-large", "multilingual-e5-small", "intfloat/e5-base-v2", etc. —
 * because every e5 release ships the same prefix requirement.
 *
 * Other asymmetric models (BGE-large-en-v1.5 wants "Represent this
 * sentence for searching relevant passages: " on queries only) need
 * their own detection branch when we add them. BGE-M3 doesn't need
 * prefixes — it routes asymmetry internally.
 */
function isE5Family(modelId: string): boolean {
    return /(^|[/\-_])e5([\-_]|$)/i.test(modelId);
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
    public readonly modelId: string;
    public readonly dimension: number;
    /** Cached prefix mode so we don't re-run the regex on every embed. */
    private readonly asymmetric: boolean;

    constructor(opts: LocalEmbeddingProviderOptions = {}) {
        this.modelId = opts.modelId ?? DEFAULT_LOCAL_MODEL_ID;
        this.dimension = opts.dimension ?? DEFAULT_LOCAL_MODEL_DIM;
        this.asymmetric = isE5Family(this.modelId);
    }

    async initialize(): Promise<void> {
        await loadPipeline(this.modelId);
    }

    /**
     * Generic embed. For asymmetric (e5) models we treat this as the
     * document-side path — that's the conservative choice because all
     * stored data goes through `store()` → `embedDocument()` and any
     * remaining caller of plain `embed()` is more likely persisting
     * than querying. Direct callers that want the query-side variant
     * must use `embedQuery()` explicitly.
     */
    async embed(text: string): Promise<number[]> {
        return this.asymmetric ? this.embedDocument(text) : this.runEmbed(text);
    }

    async embedQuery(text: string): Promise<number[]> {
        if (this.asymmetric) return this.runEmbed(`query: ${text}`);
        return this.runEmbed(text);
    }

    async embedDocument(text: string): Promise<number[]> {
        if (this.asymmetric) return this.runEmbed(`passage: ${text}`);
        return this.runEmbed(text);
    }

    /**
     * Layer 2 (reconnect-fix, 2026-04-30) — batch document embedding.
     * Calls the HF pipeline once with an array; tokenizer + ONNX session
     * batch internally. ~3-5x throughput vs one-at-a-time on CPU.
     *
     * For asymmetric (e5) models we prepend "passage: " to each text
     * before batching.
     */
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const embedder = await loadPipeline(this.modelId);
        const inputs = this.asymmetric
            ? texts.map((t) => `passage: ${t}`)
            : texts;
        // pipeline returns a Tensor with `.data` (Float32Array of length
        // N*dim) and `.dims` ([N, dim]). Slice it into N row-vectors.
        const output = await embedder(inputs, { pooling: 'mean', normalize: true });
        const flat = output.data as Float32Array;
        const dim = output.dims?.[1] ?? this.dimension;
        const rows: number[][] = [];
        for (let i = 0; i < texts.length; i++) {
            rows.push(Array.from(flat.subarray(i * dim, (i + 1) * dim)));
        }
        return rows;
    }

    /** Inner: tokenize, mean-pool, L2-normalize. */
    private async runEmbed(text: string): Promise<number[]> {
        const embedder = await loadPipeline(this.modelId);
        const output = await embedder(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data) as number[];
    }
}
