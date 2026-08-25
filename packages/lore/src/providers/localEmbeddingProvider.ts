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
 * Default ONNX dtype for the local model. `'q8'` loads
 * `onnx/model_quantized.onnx` (~60 MB) instead of the fp32 variant
 * (~470 MB) with negligible recall-quality difference for 384-d e5-small.
 * Override via `LocalEmbeddingProviderOptions.dtype` or
 * `LORE_LOCAL_EMBEDDING_DTYPE=fp32` env var when fp32 parity is required.
 */
export const DEFAULT_LOCAL_MODEL_DTYPE = (process.env['LORE_LOCAL_EMBEDDING_DTYPE'] as ModelDtype | undefined) ?? 'q8';

/**
 * Slice 7 alias retained for back-compat. Equal to
 * `DEFAULT_LOCAL_MODEL_ID` after the post-7 flip — kept as a separate
 * export so external code that imports the constant by name (telemetry
 * dashboards, external manifests, third-party scaffolds) doesn't break.
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

/**
 * Module-scoped pipeline cache keyed by `${modelId}:${device ?? 'cpu'}:${dtype}`.
 * Using a Map fixes two bugs in the single-slot design:
 *   (a) a rejected load-promise was permanently cached and retries always
 *       failed with the same error, even after the root cause was resolved;
 *   (b) requesting a second modelId silently returned the first model's
 *       pipeline because the slot was already filled.
 */
const pipelineCache = new Map<string, Promise<any>>();

/**
 * Optional ONNX execution provider for the in-process pipeline.
 *
 *  - `'cpu'`  — the safe default. Works on every host.
 *  - `'coreml'` — Apple Silicon CoreML EP. ~2-5× CPU on small models when
 *               CoreML is compiled into onnxruntime-node (the 1.24.x build
 *               we use does ship it; verify via `/health.embeddingBackend`).
 *  - `'webgpu'` — bundled WebGPU EP. Useful on hosts with discrete GPUs.
 *  - `'auto'` — let transformers.js pick. Order: cuda > coreml > webgpu > cpu.
 *
 * Selection is deliberate per the operator-driven embedder policy
 * (see CHANGELOG entry for the silent-auto-detect revert): the env var
 * is opt-in. New installs stay on CPU by default; operators run
 * `lore embedder check` to see what's available, then set
 * `LORE_LOCAL_EMBEDDING_DEVICE=coreml` to switch.
 */
type LoadDevice = 'cpu' | 'coreml' | 'webgpu' | 'cuda' | 'auto' | 'gpu';

/**
 * ONNX model precision/quantization variant.
 *
 *  - `'fp32'` — full precision. Loads `onnx/model.onnx` (~470 MB).
 *  - `'fp16'` — half precision. Loads `onnx/model_fp16.onnx` (~235 MB).
 *  - `'q8'`  — 8-bit quantized. Loads `onnx/model_quantized.onnx` (~60 MB).
 *             Default — negligible recall difference vs fp32 for e5-small;
 *             ~8× smaller download. Set LORE_LOCAL_EMBEDDING_DTYPE=fp32 to
 *             revert if you need exact fp32 parity for cross-device vector
 *             comparison against an existing fp32 LanceDB store.
 */
export type ModelDtype = 'fp32' | 'fp16' | 'q8' | 'q4';

async function loadPipeline(modelId: string, device?: LoadDevice, dtype?: ModelDtype): Promise<any> {
    const key = `${modelId}:${device ?? 'cpu'}:${dtype ?? 'default'}`;
    const existing = pipelineCache.get(key);
    if (existing) return existing;
    // pipeline() accepts `device` (ORT executionProviders) and `dtype`
    // (selects which ONNX file to load; 'q8' → model_quantized.onnx).
    const opts: { device?: LoadDevice; dtype?: ModelDtype } = {};
    if (device) opts.device = device;
    if (dtype) opts.dtype = dtype;
    const p = pipeline('feature-extraction', modelId, opts).catch((err: unknown) => {
        // Remove the rejected entry so a subsequent call can retry cleanly.
        pipelineCache.delete(key);
        return Promise.reject(err);
    });
    pipelineCache.set(key, p);
    return p;
}

/**
 * Test-only: drop the cached pipeline so a subsequent call reloads it.
 * Not part of the EmbeddingProvider contract; only used in tests that
 * exercise initialization paths.
 */
export function _resetLocalEmbeddingPipelineForTests(): void {
    pipelineCache.clear();
}

export interface LocalEmbeddingProviderOptions {
    /** HF model id; defaults to DEFAULT_LOCAL_MODEL_ID. */
    modelId?: string;
    /** Vector dimension; defaults to DEFAULT_LOCAL_MODEL_DIM. */
    dimension?: number;
    /**
     * Optional ONNX execution-provider hint (`'cpu' | 'coreml' | 'webgpu' |
     * 'cuda' | 'auto' | 'gpu'`). Maps to transformers.js's `pipeline({device})`
     * which in turn populates ORT's `executionProviders`. Default = undefined,
     * which keeps the pre-v1.1 behaviour (CPU on Node).
     *
     * Operator opt-in via the `LORE_LOCAL_EMBEDDING_DEVICE` env var. The
     * actual EPs available on this host can be inspected via
     * `/health.embeddingBackend.providers`.
     */
    device?: LoadDevice;
    /**
     * ONNX model precision variant. Defaults to `DEFAULT_LOCAL_MODEL_DTYPE`
     * (`'q8'`). Pass `'fp32'` to load the full-precision model if you need
     * exact parity with an existing fp32 LanceDB store on another device.
     * The cross-device fingerprint is `modelId + '@' + dtype`.
     */
    dtype?: ModelDtype;
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

/**
 * Audit 5.8 (2026-08-17) — long-document chunking constants. The model
 * silently truncates at its ~512-token context window; chunks are sized
 * with headroom under that, with overlap so a phrase straddling a chunk
 * boundary still lands whole inside at least one chunk.
 */
const EMBED_CHUNK_TOKENS = 448;
const EMBED_CHUNK_OVERLAP = 64;
/** Char-window fallback when the pipeline exposes no usable tokenizer
 *  (~4 chars/token for English; 1200 stays under 512 tokens for prose). */
const EMBED_CHUNK_CHARS = 1200;
const EMBED_CHUNK_CHAR_OVERLAP = 150;
/** Max chunks per ONNX forward pass — bounds RAM on multi-MB documents. */
const EMBED_FORWARD_BATCH = 32;

/** Minimal structural type for the loaded feature-extraction pipeline
 *  (the upstream `pipeline()` return is untyped in this package). */
interface EmbedderPipeline {
    (texts: string[], opts: { pooling: 'mean'; normalize: true }): Promise<{ data: Float32Array; dims?: number[] }>;
    tokenizer?: {
        (text: string, opts: { add_special_tokens: boolean }): Promise<{ input_ids?: { data: ArrayLike<bigint | number> } }>;
        decode(ids: number[], opts: { skip_special_tokens: boolean }): Promise<string> | string;
    };
}

/** Mean-pool chunk vectors and L2-renormalize into one representative
 *  vector (audit 5.8). Inputs are already per-chunk normalized. */
function poolMeanNormalized(vectors: number[][], dim: number): number[] {
    const out = new Array<number>(dim).fill(0);
    for (const v of vectors) {
        for (let i = 0; i < dim; i++) out[i] += v[i] ?? 0;
    }
    const inv = 1 / vectors.length;
    let norm = 0;
    for (let i = 0; i < dim; i++) { out[i] *= inv; norm += out[i] * out[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) out[i] /= norm;
    return out;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
    public readonly modelId: string;
    public readonly dimension: number;
    /**
     * ONNX dtype actually loaded. Part of the cross-device fingerprint:
     * two installs are compatible only when both `modelId` and `dtype` match.
     * Fingerprint string: `provider.modelId + '@' + provider.dtype`.
     */
    public readonly dtype: ModelDtype;
    /** Cached prefix mode so we don't re-run the regex on every embed. */
    private readonly asymmetric: boolean;
    /** Optional ORT execution-provider hint passed to pipeline(). */
    private readonly device: LoadDevice | undefined;

    constructor(opts: LocalEmbeddingProviderOptions = {}) {
        this.modelId = opts.modelId ?? DEFAULT_LOCAL_MODEL_ID;
        this.dimension = opts.dimension ?? DEFAULT_LOCAL_MODEL_DIM;
        this.dtype = opts.dtype ?? DEFAULT_LOCAL_MODEL_DTYPE;
        this.asymmetric = isE5Family(this.modelId);
        this.device = opts.device;
    }

    async initialize(): Promise<void> {
        await loadPipeline(this.modelId, this.device, this.dtype);
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
        return this.embedDocument(text);
    }

    async embedQuery(text: string): Promise<number[]> {
        if (this.asymmetric) return this.runEmbed(`query: ${text}`);
        return this.runEmbed(text);
    }

    async embedDocument(text: string): Promise<number[]> {
        // Fast path: definitely fits the context window (even at the
        // pathological 1-token-per-byte bound) — one call, no tokenizer
        // round-trip. Preserves the runEmbed seam exactly for short docs.
        if (Buffer.byteLength(text, 'utf8') <= EMBED_CHUNK_TOKENS) {
            return this.runEmbed(this.asymmetric ? `passage: ${text}` : text);
        }
        const embedder = await loadPipeline(this.modelId, this.device, this.dtype);
        const chunks = await this.splitTextIntoChunks(embedder, text);
        const inputs = this.asymmetric ? chunks.map((c) => `passage: ${c}`) : chunks;
        const vecs = await this.runEmbedBatch(inputs);
        return vecs.length === 1 ? vecs[0] : poolMeanNormalized(vecs, this.dimension);
    }

    /**
     * Layer 2 (reconnect-fix, 2026-04-30) — batch document embedding.
     * Calls the HF pipeline once with an array; tokenizer + ONNX session
     * batch internally. ~3-5x throughput vs one-at-a-time on CPU.
     *
     * For asymmetric (e5) models we prepend "passage: " to each text
     * before batching.
     *
     * Audit 5.8 (2026-08-17) — long-document chunking. The model silently
     * truncates at its ~512-token context window, so previously everything
     * past the first page of a long document contributed NOTHING to its
     * vector (a 117 KB doc ranked below pure-filler decoys for a query
     * drawn from its own tail). Now every document is split into
     * overlapping token windows sized to fit the context window (with
     * headroom), each chunk is embedded, and the chunk vectors are
     * mean-pooled + renormalized into one representative vector — so a
     * phrase anywhere in the document moves the embedding. Tradeoff vs
     * storing one vector row per chunk: pooled vectors keep the whole
     * store/search/tombstone/export surface unchanged (one row per
     * document id), at the cost of per-chunk precision on very long docs.
     */
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const embedder = await loadPipeline(this.modelId, this.device, this.dtype);
        // 1. Split each document into context-sized overlapping chunks.
        const chunkLists = await Promise.all(
            texts.map((t) => this.splitTextIntoChunks(embedder, t)),
        );
        const flat: string[] = [];
        const counts: number[] = [];
        for (const chunks of chunkLists) {
            counts.push(chunks.length);
            for (const c of chunks) flat.push(this.asymmetric ? `passage: ${c}` : c);
        }
        // 2. Embed all chunks (forward passes bounded inside runEmbedBatch).
        const flatVecs = await this.runEmbedBatch(flat);
        // 3. Regroup per document; multi-chunk docs are mean-pooled +
        //    renormalized into one representative vector.
        const rows: number[][] = [];
        let offset = 0;
        for (const n of counts) {
            const vecs = flatVecs.slice(offset, offset + n);
            rows.push(n === 1 ? vecs[0] : poolMeanNormalized(vecs, this.dimension));
            offset += n;
        }
        return rows;
    }

    /**
     * Split `text` into overlapping windows that fit the model's context
     * (audit 5.8). Prefers the pipeline's own tokenizer for an exact token
     * count; falls back to conservative char windows when no usable
     * tokenizer is exposed. Short text returns `[text]` unchanged — the
     * single-chunk fast path is byte-identical to the pre-fix behaviour.
     */
    private async splitTextIntoChunks(embedder: EmbedderPipeline, text: string): Promise<string[]> {
        if (Buffer.byteLength(text, 'utf8') <= EMBED_CHUNK_TOKENS) return [text];
        try {
            const tokenizer = embedder?.tokenizer;
            if (tokenizer) {
                const encoded = await tokenizer(text, { add_special_tokens: false });
                const rawIds = encoded?.input_ids?.data;
                if (rawIds && typeof rawIds.length === 'number') {
                    if (rawIds.length <= EMBED_CHUNK_TOKENS) return [text];
                    const ids = Array.from(rawIds, (x) => Number(x));
                    const chunks: string[] = [];
                    const stride = EMBED_CHUNK_TOKENS - EMBED_CHUNK_OVERLAP;
                    for (let start = 0; start < ids.length; start += stride) {
                        const window = ids.slice(start, start + EMBED_CHUNK_TOKENS);
                        const chunkText: string = await tokenizer.decode(window, { skip_special_tokens: true });
                        if (chunkText && chunkText.trim().length > 0) chunks.push(chunkText);
                        if (start + EMBED_CHUNK_TOKENS >= ids.length) break;
                    }
                    if (chunks.length > 0) return chunks;
                    return [text];
                }
            }
        } catch {
            // Tokenizer unusable — fall through to char windows.
        }
        if (text.length <= EMBED_CHUNK_CHARS) return [text];
        const chunks: string[] = [];
        const stride = EMBED_CHUNK_CHARS - EMBED_CHUNK_CHAR_OVERLAP;
        for (let start = 0; start < text.length; start += stride) {
            chunks.push(text.slice(start, start + EMBED_CHUNK_CHARS));
            if (start + EMBED_CHUNK_CHARS >= text.length) break;
        }
        return chunks;
    }

    /** Inner batched forward pass: tokenize + mean-pool + L2-normalize,
     *  bounding each ONNX call so a multi-MB document (thousands of
     *  chunks) can't OOM the host. */
    private async runEmbedBatch(texts: string[]): Promise<number[][]> {
        const embedder = await loadPipeline(this.modelId, this.device, this.dtype);
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += EMBED_FORWARD_BATCH) {
            const slice = texts.slice(i, i + EMBED_FORWARD_BATCH);
            const output = await embedder(slice, { pooling: 'mean', normalize: true });
            const data = output.data as Float32Array;
            const dim = output.dims?.[1] ?? this.dimension;
            for (let r = 0; r < slice.length; r++) {
                out.push(Array.from(data.subarray(r * dim, (r + 1) * dim)));
            }
        }
        return out;
    }

    /** Inner: tokenize, mean-pool, L2-normalize. */
    private async runEmbed(text: string): Promise<number[]> {
        const embedder = await loadPipeline(this.modelId, this.device, this.dtype);
        const output = await embedder(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data) as number[];
    }
}
