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
 *
 * LORE-ASK-EMBED-IDLE-UNLOAD (2026-09-18): the entry now also tracks
 * `lastUsedAt` + `inFlight`, mirroring `providers/llmDispatch.ts`'s
 * `embeddedPipelineCache`/`CachedPipeline` for the embedded-LLM pipeline.
 * Unlike that cache, ours defaults to NEVER unloading (see
 * `EMBED_IDLE_UNLOAD_MS` below) — this pipeline was measured leak-free
 * per document indexing cycle (`docs/PERFORMANCE-MEMORY.md` §8.3), so
 * idle-unload here is a pure opt-in memory-management knob for hosts
 * that index in bursts and then idle, not a fix for a leak.
 */
interface CachedPipelineEntry {
    promise: Promise<any>;
    lastUsedAt: number;
    /**
     * Active-consumer refcount, bumped by `acquirePipeline()` BEFORE it
     * awaits the (possibly still-loading) pipeline promise, and released by
     * the caller once it's done using the resolved pipeline object — not
     * merely once the promise resolves. This mirrors llmDispatch.ts's
     * documented fix for the same race: an idle sweeper must never dispose
     * an entry a caller is actively resolving or running inference on.
     * The sweeper skips any entry with `inFlight > 0`.
     */
    inFlight: number;
}

const pipelineCache = new Map<string, CachedPipelineEntry>();

/**
 * Parse an integer env var with a fallback default. Duplicated from
 * llmDispatch.ts's identical helper (each provider file keeps its own
 * small copy rather than sharing a util module — see the repo's
 * "no misc.ts/utils.ts" file-size-budget rule).
 */
function parseEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Idle-unload timeout for the local embedding pipeline — env override:
 * `LORE_EMBED_IDLE_UNLOAD_MS`.
 *
 * Default is **0 (never unload)** — deliberately DIFFERENT from
 * llmDispatch.ts's embedded-LLM sweeper (which defaults to 3 minutes).
 * That pipeline was found to leak/pin ~1.2-1.5 GB and always idle-unloads.
 * This one was measured NOT to leak per embed cycle
 * (`docs/PERFORMANCE-MEMORY.md` §8.3 — `embed-only` config: ~0 MB/cycle,
 * R²=0.686 noise), so keeping it hot forever is today's correct default
 * and existing behavior for every host that doesn't opt in. Setting this
 * to a positive value is a pure memory-management opt-in for hosts (e.g.
 * Tapestry) that index in bursts and want ~0 resident RAM while idle.
 */
const EMBED_IDLE_UNLOAD_MS_DEFAULT = 0;
const EMBED_IDLE_UNLOAD_MS = parseEnvInt('LORE_EMBED_IDLE_UNLOAD_MS', EMBED_IDLE_UNLOAD_MS_DEFAULT);
/**
 * Sweeper check interval. 30s matches llmDispatch.ts's fixed interval for
 * its realistic (minutes-scale) default window — but unlike that sweeper,
 * ours must also behave sanely for a short test/opt-in window: a fixed 30s
 * interval would mean `LORE_EMBED_IDLE_UNLOAD_MS=1000` could wait up to
 * ~31s to actually evict, which defeats the point of a short window and
 * doesn't match this feature's own acceptance contract (a 1s window should
 * be observably swept within a couple of seconds). So the interval scales
 * down for small windows — never above 30s, never below 250ms (avoid a
 * busy-loop) — and is exactly 30s for anything at/above 60s, preserving
 * the LLM-side behavior for realistic multi-minute windows.
 */
const EMBED_IDLE_CHECK_INTERVAL_MS = EMBED_IDLE_UNLOAD_MS > 0
    ? Math.min(30 * 1000, Math.max(250, Math.floor(EMBED_IDLE_UNLOAD_MS / 2)))
    : 30 * 1000;
let embedIdleSweeper: ReturnType<typeof setInterval> | null = null;

/**
 * Lazily arm the idle-unload sweeper. Not armed at module-eval time and
 * not armed at all when `EMBED_IDLE_UNLOAD_MS <= 0` (the default) — so
 * importing this module, or using it with idle-unload left disabled,
 * registers no timers. Mirrors llmDispatch.ts 4.6 (2026-08-17): "the idle
 * sweeper is armed lazily on the first embedded-model load ... so
 * importing this module registers no timers." Called unconditionally
 * (not gated on `ownsProcess`/deploymentMode) — see CLAUDE.md's
 * process-ownership section and the LORE-ASK's rules: this is a pure
 * memory-management timer, unref'd, stoppable, and harmless to leave
 * ticking in a host that never disposes.
 */
function ensureEmbedIdleSweeper(): void {
    if (embedIdleSweeper !== null || EMBED_IDLE_UNLOAD_MS <= 0) return;
    embedIdleSweeper = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of pipelineCache.entries()) {
            // Never dispose an entry with an active consumer — see
            // CachedPipelineEntry.inFlight.
            if (entry.inFlight > 0) continue;
            if (now - entry.lastUsedAt < EMBED_IDLE_UNLOAD_MS) continue;
            pipelineCache.delete(key);
            // Transformers.js pipelines may expose an optional dispose()
            // hook on some architectures; call it defensively/best-effort.
            void entry.promise.then((p) => {
                try { p?.dispose?.(); } catch { /* ignore */ }
            }).catch(() => { /* ignore — a rejected load has nothing to dispose */ });
        }
    }, EMBED_IDLE_CHECK_INTERVAL_MS);
    // Don't keep the event loop alive for this timer alone.
    embedIdleSweeper.unref?.();
}

/** Stop the local-embedding idle-unload sweeper (host dispose). Idempotent. */
export function stopEmbedIdleSweeper(): void {
    if (embedIdleSweeper !== null) {
        clearInterval(embedIdleSweeper);
        embedIdleSweeper = null;
    }
}

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

function cacheKeyFor(modelId: string, device?: LoadDevice, dtype?: ModelDtype): string {
    return `${modelId}:${device ?? 'cpu'}:${dtype ?? 'default'}`;
}

/** Get the cache entry for (modelId, device, dtype), creating and kicking
 *  off the pipeline() load if it doesn't exist yet. Does NOT bump
 *  `inFlight` — callers that will actually use the resolved pipeline must
 *  go through `acquirePipeline()` instead, which claims the entry first. */
function getOrCreateEntry(modelId: string, device?: LoadDevice, dtype?: ModelDtype): CachedPipelineEntry {
    const key = cacheKeyFor(modelId, device, dtype);
    const existing = pipelineCache.get(key);
    if (existing) return existing;
    // pipeline() accepts `device` (ORT executionProviders) and `dtype`
    // (selects which ONNX file to load; 'q8' → model_quantized.onnx).
    const opts: { device?: LoadDevice; dtype?: ModelDtype } = {};
    if (device) opts.device = device;
    if (dtype) opts.dtype = dtype;
    const promise = pipeline('feature-extraction', modelId, opts).catch((err: unknown) => {
        // Remove the rejected entry so a subsequent call can retry cleanly.
        pipelineCache.delete(key);
        return Promise.reject(err);
    });
    const entry: CachedPipelineEntry = { promise, lastUsedAt: Date.now(), inFlight: 0 };
    pipelineCache.set(key, entry);
    return entry;
}

/**
 * Acquire the pipeline for (modelId, device, dtype) for active use.
 *
 * Claims an in-flight slot on the cache entry BEFORE awaiting its
 * (possibly still-loading) promise, exactly like llmDispatch.ts's embedded
 * pipeline does — "claim the entry BEFORE we await its promise so the
 * sweeper can't dispose it out from under us." The returned `release()`
 * MUST be called in a `finally` once the caller is done using the
 * resolved pipeline object (not merely once this function returns) — the
 * in-flight window has to cover the actual ONNX forward pass / tokenizer
 * call, not just the cache lookup, or the sweeper could race a call that's
 * about to start running inference.
 *
 * `release()` is idempotent and safe to call multiple times.
 */
async function acquirePipeline(
    modelId: string,
    device?: LoadDevice,
    dtype?: ModelDtype,
    // Return type intentionally left as `any` (matches the pre-existing
    // `loadPipeline(): Promise<any>` contract): the upstream pipeline is
    // callable both as `embedder(text, opts)` (runEmbed) and
    // `embedder(texts[], opts)` (runEmbedBatch), which a single structural
    // interface can't express without weakening EmbedderPipeline's own
    // (deliberately narrow) tokenizer-focused shape used by
    // splitTextIntoChunks.
): Promise<{ embedder: any; release: () => void }> {
    const entry = getOrCreateEntry(modelId, device, dtype);
    entry.inFlight++;
    // Arm the sweeper only once a pipeline is actually cached (mirrors
    // where llmDispatch.ts calls ensureIdleSweeper(), right after
    // embeddedPipelineCache.set()) — never at module-eval time.
    ensureEmbedIdleSweeper();
    let released = false;
    const release = (): void => {
        if (released) return;
        released = true;
        entry.lastUsedAt = Date.now();
        entry.inFlight = Math.max(0, entry.inFlight - 1);
    };
    try {
        const embedder = await entry.promise;
        return { embedder, release };
    } catch (err) {
        release();
        throw err;
    }
}

/**
 * Release the cached local-embedding pipeline(s), freeing RAM immediately
 * rather than waiting for the idle sweeper. Exported for hosts that know
 * they're about to go idle (e.g. after a bulk-index burst) and don't want
 * to wait out `LORE_EMBED_IDLE_UNLOAD_MS`.
 *
 * Semantics for an entry currently in use (`inFlight > 0`): this function
 * does NOT force-release it and does NOT wait for it to finish — it skips
 * that entry and moves on. Rationale: an explicit caller here is a host
 * managing its own memory, not a background sweeper, but ripping a
 * pipeline out from under an in-progress ONNX forward pass is the exact
 * "Session already disposed" failure llmDispatch.ts's inFlight guard was
 * built to prevent (see CachedPipelineEntry.inFlight); silently skipping
 * is safer than either force-releasing or blocking. If a caller needs a
 * guaranteed release, it should await its own embed calls to complete
 * first (there is no in-progress embed left running once `embed*()`
 * promises have resolved).
 *
 * Returns `true` if at least one pipeline was actually released.
 */
export function releaseLocalEmbeddingPipeline(): boolean {
    let releasedAny = false;
    for (const [key, entry] of pipelineCache.entries()) {
        if (entry.inFlight > 0) continue;
        pipelineCache.delete(key);
        releasedAny = true;
        void entry.promise.then((p) => {
            try { p?.dispose?.(); } catch { /* ignore */ }
        }).catch(() => { /* ignore — a rejected load has nothing to dispose */ });
    }
    return releasedAny;
}

/**
 * Test-only: drop the cached pipeline so a subsequent call reloads it.
 * Not part of the EmbeddingProvider contract; only used in tests that
 * exercise initialization paths.
 */
export function _resetLocalEmbeddingPipelineForTests(): void {
    pipelineCache.clear();
}

/**
 * Test-only: number of distinct ONNX pipelines currently loaded (keyed by
 * `${modelId}:${device}:${dtype}` — see loadPipeline). Used both by the
 * idle-unload assertions (current pipeline-cache size) and by the
 * injected-embedding-provider acceptance test to assert a child process
 * that only ever used an INJECTED provider never triggered a real model
 * load (`pipeline('feature-extraction', ...)` from @huggingface/transformers)
 * — the count must stay 0 for the whole run.
 */
export function _pipelineCacheSizeForTests(): number {
    return pipelineCache.size;
}

/**
 * Cross-device fingerprint helper (Q2.2 follow-up — injected-embedding-
 * provider sprint). `LocalEmbeddingProvider.dtype`'s own doc comment has
 * always said "the cross-device fingerprint is `modelId + '@' + dtype`",
 * but until now that was only a comment — nothing computed it. Exported so
 * a host embedding Lore (or Lore's own fingerprint-compatibility code) can
 * derive the same string without duplicating the concatenation rule.
 *
 * Parity contract: any provider — local, remote or host-injected — that
 * declares the same `modelId` and `dtype` (EmbeddingProvider.dtype) yields
 * the IDENTICAL string. A provider that declares no dtype is fingerprinted
 * by `modelId` alone (and is refused by strict fingerprint checking against
 * a store that recorded a dtype — see engines/verbatimFingerprintGate.ts).
 */
export function embeddingProviderFingerprint(
    provider: Pick<EmbeddingProvider, 'modelId' | 'dtype'>,
): string {
    return provider.dtype ? `${provider.modelId}@${provider.dtype}` : provider.modelId;
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
        // Warm-up only — nothing here touches the resolved pipeline
        // afterward, so it's safe to release the in-flight claim as soon
        // as the load settles.
        const { release } = await acquirePipeline(this.modelId, this.device, this.dtype);
        release();
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
        // Claim the pipeline for the duration of the tokenizer-backed split
        // below — this IS active use of the pipeline (its tokenizer), not
        // just a cache lookup, so it must hold inFlight until done.
        const { embedder, release } = await acquirePipeline(this.modelId, this.device, this.dtype);
        let chunks: string[];
        try {
            chunks = await this.splitTextIntoChunks(embedder, text);
        } finally {
            release();
        }
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
        // Claim the pipeline for the duration of the tokenizer-backed split
        // below (see embedDocument's identical comment).
        const { embedder, release } = await acquirePipeline(this.modelId, this.device, this.dtype);
        let chunkLists: string[][];
        try {
            // 1. Split each document into context-sized overlapping chunks.
            chunkLists = await Promise.all(
                texts.map((t) => this.splitTextIntoChunks(embedder, t)),
            );
        } finally {
            release();
        }
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

    /**
     * D7 (3.23, piece-level vectors, design 2.4) — split `text` into
     * overlapping windows of ~`windowTokens` tokens with `overlapTokens`
     * overlap, using this provider's own tokenizer for an exact count.
     * Generalises {@link splitTextIntoChunks} above (same tokenizer +
     * decode calls), parameterized instead of the hardcoded
     * EMBED_CHUNK_TOKENS/EMBED_CHUNK_OVERLAP document-chunking constants.
     *
     * Unlike `splitTextIntoChunks`, this method has NO char-window
     * fallback — it throws when the loaded pipeline exposes no usable
     * tokenizer. The caller (`engines/pieces/pieceLayout.ts`) is
     * responsible for catching that and applying its own fixed 480/120
     * char-window fallback (design 2.4); duplicating that fallback here
     * would let two different call sites silently disagree on it.
     *
     * Never prepends the asymmetric `query: `/`passage: ` prefix — this
     * only splits text; the prefix is applied exactly once, later, by
     * `embedDocument`/`embedDocumentBatch` when the caller embeds the
     * returned windows.
     */
    async splitIntoWindows(text: string, windowTokens: number, overlapTokens: number): Promise<string[]> {
        // Cheap pre-check: worst case is 1 token/byte (see embedDocument's
        // identical comment), so a byte length under the window size means
        // the token count is too — no need to touch the tokenizer.
        if (Buffer.byteLength(text, 'utf8') <= windowTokens) return [text];
        const { embedder, release } = await acquirePipeline(this.modelId, this.device, this.dtype);
        try {
            const tokenizer = embedder?.tokenizer;
            if (!tokenizer) {
                throw new Error('LocalEmbeddingProvider.splitIntoWindows: no usable tokenizer on this pipeline');
            }
            const encoded = await tokenizer(text, { add_special_tokens: false });
            const rawIds = encoded?.input_ids?.data;
            if (!rawIds || typeof rawIds.length !== 'number') {
                throw new Error('LocalEmbeddingProvider.splitIntoWindows: tokenizer returned no usable token ids');
            }
            if (rawIds.length <= windowTokens) return [text];
            const ids = Array.from(rawIds, (x) => Number(x));
            const windows: string[] = [];
            const stride = Math.max(1, windowTokens - overlapTokens);
            for (let start = 0; start < ids.length; start += stride) {
                const window = ids.slice(start, start + windowTokens);
                const windowText: string = await tokenizer.decode(window, { skip_special_tokens: true });
                if (windowText && windowText.trim().length > 0) windows.push(windowText);
                if (start + windowTokens >= ids.length) break;
            }
            return windows.length > 0 ? windows : [text];
        } finally {
            release();
        }
    }

    /** Inner batched forward pass: tokenize + mean-pool + L2-normalize,
     *  bounding each ONNX call so a multi-MB document (thousands of
     *  chunks) can't OOM the host. */
    private async runEmbedBatch(texts: string[]): Promise<number[][]> {
        const { embedder, release } = await acquirePipeline(this.modelId, this.device, this.dtype);
        try {
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
        } finally {
            release();
        }
    }

    /** Inner: tokenize, mean-pool, L2-normalize. */
    private async runEmbed(text: string): Promise<number[]> {
        const { embedder, release } = await acquirePipeline(this.modelId, this.device, this.dtype);
        try {
            const output = await embedder(text, { pooling: 'mean', normalize: true });
            return Array.from(output.data) as number[];
        } finally {
            release();
        }
    }
}
