/**
 * localRerankProvider.ts — D8 (Lore 3.23): optional local cross-encoder
 * re-rank of the top-K retrieve() results.
 *
 * In-process cross-encoder scorer backed by HuggingFace Transformers.js
 * (`Xenova/ms-marco-MiniLM-L-6-v2` by default, `q8` quantized, ~23 MB).
 * `score()` returns one raw logit per (query, passage) pair — the caller
 * (`recall/rerankStage.ts`) owns piece construction, per-candidate
 * max-grouping and the margin gate; this class knows nothing about
 * candidates, pieces or gating.
 *
 * Offline enforcement (design DESIGN-3.23.md §3.3):
 *   - `cache_dir` is passed PER-CALL to `from_pretrained()`. This module
 *     NEVER reads or writes the global `env.cacheDir` / `env.allowRemoteModels`
 *     / `env.localModelPath` — those are process-global, and
 *     `providers/llmDispatch.ts` already owns toggling them for its own
 *     (unrelated) embedded-LLM path. Mutating them here would race or
 *     clobber that owner — exactly the anti-pattern §3.3 forbids.
 *   - `rerankModelCached()` does a pure filesystem check BEFORE this module
 *     ever imports `@huggingface/transformers`, so a host with no cached
 *     model pays zero import/init cost on the common "not fetched yet"
 *     path — `rerankStage.ts` fails open with `reason:'model_absent'`
 *     without this module touching the transformers package at all.
 *   - transformers is imported dynamically (`await import(...)`), never
 *     statically at module top, so merely importing localRerankProvider.ts
 *     never loads the transformers runtime.
 *
 * Model cache layout: `<loreHomePath('models')>/<modelId>/...` — the same
 * root `providers/llmDispatch.ts` and `cli/commands/models.ts` (prune) use.
 * Fetching happens only via `lore models fetch-rerank` (D8b, out of this
 * slice's scope), the one code path allowed to pass `local_files_only:false`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { resolveModelDirSafe, validateRerankModelId } from './rerankModelId.js';
import { DEFAULT_RERANK_MANIFEST, RERANK_DTYPE_ONNX_FILE, RERANK_COMMON_FILES } from './rerankManifest.js';

/** Duplicated literal (not imported from rerankConfig.ts) — rerankConfig.ts
 *  already has a one-way TYPE-ONLY import of `RerankDtype` FROM this file;
 *  keeping this a literal here avoids turning that into a runtime import
 *  cycle for the sake of one string comparison. Both are asserted equal by
 *  a unit test (`f4-manifest-model-id-unit`). */
const DEFAULT_RERANK_MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';

/** ONNX dtype. Fixed at `'q8'` by rerankConfig.ts unless
 *  `LORE_RECALL_RERANK_DTYPE` overrides it. */
export type RerankDtype = 'fp32' | 'fp16' | 'q8' | 'q4';

export interface LocalRerankProviderOptions {
    modelId: string;
    dtype?: RerankDtype;
    /** Absolute cache dir — callers pass `loreHomePath('models')`. */
    cacheDir: string;
}

/** Thrown by `getOrCreateEntry` when the on-disk model content for the
 *  DEFAULT model doesn't match `rerankManifest.ts`'s pinned sha256 values.
 *  `rerankStage.ts` catches this and maps it to `reason:'integrity_failed'`
 *  — fail open (unchanged order), never a thrown error to the caller. See
 *  $SP/SECURITY-D8.md F4. */
export class RerankIntegrityError extends Error {
    constructor(modelId: string, relPath: string) {
        super(`rerank model "${modelId}": integrity check failed for "${relPath}" (sha256 mismatch against pinned manifest)`);
        this.name = 'RerankIntegrityError';
    }
}

function sha256File(p: string): string {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(p));
    return hash.digest('hex');
}

/**
 * Pure filesystem check for whether `modelId`+`dtype` is already cached and
 * *verified-complete* under `dir` — no transformers import, no network.
 *
 * D8d (F5) hardening: a loose "some tokenizer.json + some .onnx file exist
 * somewhere under here" check (D8b/D8c's original heuristic) could be
 * satisfied by a partial/interrupted download, or by a leftover file from a
 * different dtype. This now requires:
 *   1. `modelId` passes `validateRerankModelId` and resolves (via
 *      `resolveModelDirSafe`) to a real, non-symlinked directory that stays
 *      under `dir` after `fs.realpathSync` (F3 defense-in-depth).
 *   2. A `.complete` marker file is present, written by `lore models
 *      fetch-rerank` only after every file was downloaded and (for the
 *      default model) sha256-verified — see `modelsFetch.ts`. The marker
 *      itself is `lstat`'d (never followed if it's a symlink).
 *   3. The exact dtype-specific ONNX file (`RERANK_DTYPE_ONNX_FILE[dtype]`)
 *      and the 3 common files are present as real files (lstat, no symlink
 *      follow) — so a `.complete` marker left over from a differently-dtyped
 *      fetch doesn't falsely validate an unfetched dtype.
 */
export function rerankModelCached(modelId: string, dtype: RerankDtype, dir: string): boolean {
    const modelDir = resolveModelDirSafe(dir, modelId);
    if (!modelDir) return false;
    const markerPath = path.join(modelDir, '.complete');
    try {
        const st = fs.lstatSync(markerPath);
        if (!st.isFile()) return false;
    } catch {
        return false;
    }
    const required = [...RERANK_COMMON_FILES, `onnx/${RERANK_DTYPE_ONNX_FILE[dtype]}`];
    for (const rel of required) {
        try {
            const st = fs.lstatSync(path.join(modelDir, rel));
            if (!st.isFile()) return false;
        } catch {
            return false;
        }
    }
    return true;
}

interface CachedProviderEntry {
    promise: Promise<{ tokenizer: RerankTokenizer; model: RerankModel }>;
    lastUsedAt: number;
    /** Active-consumer refcount — see localEmbeddingProvider.ts's
     *  CachedPipelineEntry.inFlight for the full rationale. The idle
     *  sweeper never disposes an entry with inFlight > 0. */
    inFlight: number;
}

/** Minimal structural types for the loaded tokenizer/model (the upstream
 *  transformers.js return values are untyped in this package). */
interface RerankTokenizer {
    (queries: string[], opts: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number }): unknown;
}
interface RerankModel {
    (inputs: unknown): Promise<{ logits: { data: Float32Array | number[]; dims?: number[] } }>;
    dispose?: () => void;
}

const providerCache = new Map<string, CachedProviderEntry>();

/** Duplicated from localEmbeddingProvider.ts's identical helper — each
 *  provider file keeps its own small copy rather than sharing a util
 *  module (see the repo's "no misc.ts/utils.ts" file-size-budget rule). */
function parseEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Idle-unload timeout for the cached tokenizer/model pair — env override
 * `LORE_RECALL_RERANK_IDLE_UNLOAD_MS`, default 300000 (5 min).
 *
 * Unlike localEmbeddingProvider.ts's embed pipeline (measured leak-free,
 * so it defaults to never unloading), the loaded cross-encoder holds
 * ~400-900MB and reloads in ~0.3s, so it is unloaded after 5 idle minutes
 * to give the memory back on hosts that only sometimes recall.
 *
 * SECURITY-D8 F7 / owner decision 2026-09-25: there is deliberately NO
 * "never unload" value. `<= 0` (or garbage) falls back to the 5-minute
 * default, so a typo can't pin the model in memory for the process
 * lifetime. An operator who wants it kept hot sets a large value.
 */
export const DEFAULT_RERANK_IDLE_UNLOAD_MS = 300_000;
export function resolveRerankIdleUnloadMs(raw: string | undefined): number {
    if (!raw || raw.trim() === '') return DEFAULT_RERANK_IDLE_UNLOAD_MS;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RERANK_IDLE_UNLOAD_MS;
}
const RERANK_IDLE_UNLOAD_MS = resolveRerankIdleUnloadMs(process.env.LORE_RECALL_RERANK_IDLE_UNLOAD_MS);
/** Sweeper check interval — scales down for small windows (tests), never
 *  above 30s, never below 250ms. Mirrors localEmbeddingProvider.ts's
 *  identical scaling rationale. */
const RERANK_IDLE_CHECK_INTERVAL_MS = Math.min(30 * 1000, Math.max(250, Math.floor(RERANK_IDLE_UNLOAD_MS / 2)));
let rerankIdleSweeper: ReturnType<typeof setInterval> | null = null;

/** Lazily arm the idle-unload sweeper. Not armed at module-eval time —
 *  importing this module registers no timers. Unref'd so it never keeps
 *  the process alive. */
function ensureRerankIdleSweeper(): void {
    if (rerankIdleSweeper !== null) return;
    rerankIdleSweeper = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of providerCache.entries()) {
            if (entry.inFlight > 0) continue;
            if (now - entry.lastUsedAt < RERANK_IDLE_UNLOAD_MS) continue;
            providerCache.delete(key);
            void entry.promise.then(({ model }) => {
                try { model?.dispose?.(); } catch { /* best-effort dispose only */ }
            }).catch(() => { /* a rejected load has nothing to dispose */ });
        }
    }, RERANK_IDLE_CHECK_INTERVAL_MS);
    rerankIdleSweeper.unref?.();
}

/** Test-only: stop the idle sweeper and drop the cached provider(s) so a
 *  subsequent call reloads. Not part of any production contract. */
export function _resetLocalRerankProviderForTests(): void {
    if (rerankIdleSweeper !== null) {
        clearInterval(rerankIdleSweeper);
        rerankIdleSweeper = null;
    }
    providerCache.clear();
}

/** Test-only: number of distinct tokenizer/model pairs currently loaded. */
export function _providerCacheSizeForTests(): number {
    return providerCache.size;
}

function cacheKeyFor(modelId: string, dtype: RerankDtype, cacheDir: string): string {
    return `${modelId}:${dtype}:${cacheDir}`;
}

/** F7: cap on distinct (modelId, dtype, cacheDir) tokenizer/model pairs kept
 *  resident at once. In normal operation there is exactly one (the default
 *  model) — this exists to bound a host that churns `--model` across many
 *  workspaces from accumulating unbounded resident ONNX sessions faster
 *  than the idle sweeper (which only runs every
 *  `RERANK_IDLE_CHECK_INTERVAL_MS`) would reclaim them. Override via
 *  `LORE_RECALL_RERANK_MAX_CACHED_MODELS`, minimum 1. */
const RERANK_MAX_CACHED_MODELS = Math.max(1, parseEnvInt('LORE_RECALL_RERANK_MAX_CACHED_MODELS', 3));

/** Evict the least-recently-used entry with `inFlight === 0` if the cache is
 *  at or over `RERANK_MAX_CACHED_MODELS` *before* inserting a new one. If
 *  every entry is currently in-flight, the cache is allowed to exceed the
 *  cap rather than disposing a model mid-use — this is a soft cap, not a
 *  hard admission limit (scoring correctness > memory bound). */
function evictOverCapIfNeeded(): void {
    if (providerCache.size < RERANK_MAX_CACHED_MODELS) return;
    let lruKey: string | undefined;
    let lruAt = Infinity;
    for (const [key, entry] of providerCache.entries()) {
        if (entry.inFlight > 0) continue;
        if (entry.lastUsedAt < lruAt) {
            lruAt = entry.lastUsedAt;
            lruKey = key;
        }
    }
    if (lruKey === undefined) return; // everything in-flight — allow over-cap
    const evicted = providerCache.get(lruKey);
    providerCache.delete(lruKey);
    void evicted?.promise.then(({ model }) => {
        try { model?.dispose?.(); } catch { /* best-effort dispose only */ }
    }).catch(() => { /* a rejected load has nothing to dispose */ });
}

/** Verify the DEFAULT model's on-disk content against the pinned sha256
 *  manifest (F4). Non-default models have no manifest and are not checked
 *  here — `rerankModelCached`'s `.complete`-marker requirement is their
 *  only integrity gate. Throws `RerankIntegrityError` on any mismatch;
 *  callers must treat that as fail-open (`reason:'integrity_failed'`),
 *  never surfaced to the end user as a thrown error. */
function verifyDefaultManifestOrThrow(modelId: string, modelDir: string): void {
    for (const [relPath, expectedHash] of Object.entries(DEFAULT_RERANK_MANIFEST)) {
        const filePath = path.join(modelDir, relPath);
        let st: fs.Stats;
        try {
            st = fs.lstatSync(filePath);
        } catch {
            throw new RerankIntegrityError(modelId, relPath);
        }
        if (!st.isFile()) throw new RerankIntegrityError(modelId, relPath);
        if (sha256File(filePath) !== expectedHash) throw new RerankIntegrityError(modelId, relPath);
    }
}

/** Get (or start loading) the cache entry for (modelId, dtype, cacheDir).
 *  Does NOT bump `inFlight` — callers that will actually use the resolved
 *  tokenizer/model must go through `acquireProvider()`, which claims the
 *  entry first (same single-flight discipline as localEmbeddingProvider.ts's
 *  acquirePipeline).
 *
 *  D8d (F1/F4) hardening: resolves `modelId` to an absolute,
 *  realpath-contained directory via `resolveModelDirSafe` and passes THAT
 *  (never the raw `modelId` string) to `from_pretrained()`. Upstream
 *  Transformers.js's `get_tokenizer_files.js` has a secondary code path
 *  (`get_file_metadata()` called with no options, dropping `cache_dir`/
 *  `local_files_only`) that can trigger a live network request keyed off
 *  a repo-id-shaped string even when the caller asked for
 *  `local_files_only:true` — passing an absolute filesystem path instead of
 *  an `org/name`-shaped id means that upstream code path's own
 *  `isValidHfModelId()` check fails closed (an absolute path never matches
 *  `REPO_ID_REGEX`), so it can no longer reach the network fetch branch at
 *  all. See $SP/SECURITY-D8.md F1 and evidence/d8d/f1-*.log. */
function getOrCreateEntry(modelId: string, dtype: RerankDtype, cacheDir: string): CachedProviderEntry {
    const key = cacheKeyFor(modelId, dtype, cacheDir);
    const existing = providerCache.get(key);
    if (existing) return existing;
    const promise = (async (): Promise<{ tokenizer: RerankTokenizer; model: RerankModel }> => {
        if (!validateRerankModelId(modelId)) {
            throw new Error(`rerank: invalid model id "${modelId}"`);
        }
        const modelDir = resolveModelDirSafe(cacheDir, modelId);
        if (!modelDir) {
            throw new Error(`rerank: model "${modelId}" is not present under ${cacheDir}`);
        }
        if (modelId === DEFAULT_RERANK_MODEL_ID && dtype === 'q8') {
            verifyDefaultManifestOrThrow(modelId, modelDir);
        }
        // Dynamic import: this module — and so the whole rerank feature —
        // never pulls in @huggingface/transformers unless a scoring call
        // actually reaches this point. rerankStage.ts only calls in after
        // rerankModelCached() has already confirmed the files exist on
        // disk, so this import is not expected to hit the network.
        const transformers = await import('@huggingface/transformers');
        const { AutoTokenizer, AutoModelForSequenceClassification } = transformers as unknown as {
            AutoTokenizer: { from_pretrained(id: string, opts: Record<string, unknown>): Promise<RerankTokenizer> };
            AutoModelForSequenceClassification: { from_pretrained(id: string, opts: Record<string, unknown>): Promise<RerankModel> };
        };
        // Absolute, realpath-verified directory — NEVER the raw modelId —
        // and NEVER env.cacheDir / env.allowRemoteModels / env.localModelPath.
        // See file header + this function's own doc comment above (F1).
        const tokenizer = await AutoTokenizer.from_pretrained(modelDir, { cache_dir: cacheDir, local_files_only: true });
        const model = await AutoModelForSequenceClassification.from_pretrained(modelDir, {
            cache_dir: cacheDir,
            local_files_only: true,
            dtype,
            device: 'cpu',
            session_options: RERANK_SESSION_OPTIONS,
        });
        return { tokenizer, model };
    })().catch((err: unknown) => {
        // Remove the rejected entry so a subsequent call can retry cleanly.
        providerCache.delete(key);
        return Promise.reject(err);
    });
    evictOverCapIfNeeded();
    const entry: CachedProviderEntry = { promise, lastUsedAt: Date.now(), inFlight: 0 };
    providerCache.set(key, entry);
    return entry;
}

/**
 * Acquire the tokenizer/model pair for active use. Claims an in-flight
 * slot BEFORE awaiting the (possibly still-loading) promise, exactly like
 * localEmbeddingProvider.ts's acquirePipeline — so the idle sweeper can
 * never dispose an entry a caller is actively resolving or scoring with.
 * `release()` is idempotent and MUST be called in a `finally` once the
 * caller is done using the resolved pair.
 */
async function acquireProvider(
    modelId: string,
    dtype: RerankDtype,
    cacheDir: string,
): Promise<{ tokenizer: RerankTokenizer; model: RerankModel; release: () => void }> {
    const entry = getOrCreateEntry(modelId, dtype, cacheDir);
    entry.inFlight++;
    ensureRerankIdleSweeper();
    let released = false;
    const release = (): void => {
        if (released) return;
        released = true;
        entry.lastUsedAt = Date.now();
        entry.inFlight = Math.max(0, entry.inFlight - 1);
    };
    try {
        const { tokenizer, model } = await entry.promise;
        return { tokenizer, model, release };
    } catch (err) {
        release();
        throw err;
    }
}

/** Forward-pass batch size — bounds RAM/latency on a large K x pieces
 *  product. Matches design DESIGN-3.23.md §3.4 point 3 ("batches of 32").
 *
 *  D8c (2026-09-25) measured smaller batches (8, 4) as an ADDITIONAL memory
 *  lever on top of RERANK_SESSION_OPTIONS below (batch=16 -> ~648MB
 *  plateau, batch=8 -> ~487MB, batch=4 -> ~407MB, vs batch=32's ~890MB) —
 *  but batch=8/4 changed the reranked ORDER on 38-39/198 real Atlas
 *  queries versus the batch=32 baseline (including at least one top-1
 *  rank flip), which fails the "identical order, float noise only"
 *  correctness bar this slice was required to hold to. That is a real,
 *  batch-size-dependent numerical effect of the q8-quantized model's ORT
 *  kernels under variable padding, not tokenization/gating noise — see
 *  $SP/evidence/d8c/memory-matrix.md for the order-identity counts.
 *  RERANK_FORWARD_BATCH is therefore left at the design value; only the
 *  scoring-neutral allocator change below is applied. */
const RERANK_FORWARD_BATCH = 32;

/**
 * ONNX Runtime session options for the rerank model's ORT session.
 *
 * D8c (2026-09-25) root-caused the RSS growth measured against real Atlas
 * node bodies (219MB -> ~1300MB plateau over 198 queries, K=10, ~37-41
 * pieces/query, max_length 320 — see $SP/evidence/d8c/memory-matrix.md) to
 * ORT's `enableMemPattern` optimization (default true): it caches a memory
 * layout keyed by input tensor shape to speed up REPEATED inference of the
 * SAME shape, but this workload's shape (batch remainder, sequence length
 * up to the 320-token cap) varies almost every forward call, so the
 * pattern cache never gets reused and instead grows unboundedly.
 *
 * `enableCpuMemArena` is kept ON (not the culprit, and turning it off too
 * made RSS erratic and occasionally worse — its BFC-style consolidation
 * is what keeps the allocator from churning). Disabling only
 * `enableMemPattern` (batch=32 unchanged) measured: plateau RSS ~890MB
 * (down from ~1300MB, about -32%), p50/p90 latency unchanged (271-274ms /
 * 308-313ms vs baseline's 271-274ms / 308-313ms), and 0/198 reranked-order
 * mismatches versus the untouched-defaults baseline across all real
 * queries (2 full repeats each way) — i.e. this is a scoring-neutral
 * allocator-strategy change, not a numerics change. Tensor disposal after
 * each forward batch was also measured and made no difference (same
 * ~890-893MB both with and without), confirming the growth is internal to
 * the native ORT arena rather than JS-side object retention.
 */
const RERANK_SESSION_OPTIONS = {
    enableCpuMemArena: true,
    enableMemPattern: false,
} as const;

/** F2: max concurrent `score()` runs across the whole process — bounds the
 *  CPU any single (or few) hostile/careless callers can force onto the
 *  rerank cross-encoder regardless of how many distinct requests ask for
 *  `rerank:true` at once. This is a process-wide budget, not per-workspace
 *  or per-model, since the CPU cost is real and shared regardless of which
 *  model is scoring. Override via `LORE_RECALL_RERANK_MAX_CONCURRENT`,
 *  minimum 1. */
const RERANK_MAX_CONCURRENT_SCORE_RUNS = Math.max(1, parseEnvInt('LORE_RECALL_RERANK_MAX_CONCURRENT', 2));
let rerankActiveScoreRuns = 0;

/** Thrown by `LocalRerankProvider.score()` when the process-wide concurrent
 *  score-run budget is already exhausted. `rerankStage.ts` catches this and
 *  maps it to `reason:'busy'` — fail open (unchanged order), never
 *  surfaced as a thrown error to the caller. See $SP/SECURITY-D8.md F2. */
export class RerankBusyError extends Error {
    constructor() {
        super(`rerank: ${RERANK_MAX_CONCURRENT_SCORE_RUNS} concurrent score run(s) already in progress`);
        this.name = 'RerankBusyError';
    }
}

/**
 * LocalRerankProvider — cross-encoder scorer for (query, passage) pairs.
 * `score(query, passages)` returns one raw logit per passage, in the same
 * order as `passages`. It is pure I/O plumbing: piece construction,
 * per-candidate max-grouping and the margin gate all live in
 * `recall/rerankStage.ts`, which is the only intended caller.
 *
 * D8d (F2) hardening: `score()` now (a) fails fast with `RerankBusyError`
 * when `RERANK_MAX_CONCURRENT_SCORE_RUNS` process-wide runs are already in
 * flight, rather than queueing unboundedly and letting concurrent
 * `rerank:true` callers pile up CPU work, and (b) accepts an optional
 * `AbortSignal` checked BETWEEN forward-pass batches — so a timeout raised
 * by `rerankStage.ts`'s caller actually stops issuing further ONNX forward
 * passes instead of merely racing a `Promise` while the real inference work
 * keeps running to completion in the background (the previous
 * `Promise.race`-only timeout in `rerankStage.ts` never cancelled anything).
 */
export class LocalRerankProvider {
    public readonly modelId: string;
    public readonly dtype: RerankDtype;
    private readonly cacheDir: string;

    constructor(opts: LocalRerankProviderOptions) {
        this.modelId = opts.modelId;
        this.dtype = opts.dtype ?? 'q8';
        this.cacheDir = opts.cacheDir;
    }

    async score(query: string, passages: string[], signal?: AbortSignal): Promise<number[]> {
        if (passages.length === 0) return [];
        if (rerankActiveScoreRuns >= RERANK_MAX_CONCURRENT_SCORE_RUNS) {
            throw new RerankBusyError();
        }
        rerankActiveScoreRuns++;
        try {
            const { tokenizer, model, release } = await acquireProvider(this.modelId, this.dtype, this.cacheDir);
            try {
                const out: number[] = [];
                for (let i = 0; i < passages.length; i += RERANK_FORWARD_BATCH) {
                    if (signal?.aborted) {
                        throw (signal.reason instanceof Error ? signal.reason : new Error('rerank: aborted'));
                    }
                    const slice = passages.slice(i, i + RERANK_FORWARD_BATCH);
                    const queries = new Array<string>(slice.length).fill(query);
                    const inputs = tokenizer(queries, { text_pair: slice, padding: true, truncation: true, max_length: 320 });
                    const output = await model(inputs);
                    const logitsData = output.logits.data;
                    const dims = output.logits.dims;
                    const width = dims && dims.length > 1 ? dims[1] : 1;
                    for (let r = 0; r < slice.length; r++) {
                        out.push(Number(logitsData[r * width]));
                    }
                }
                return out;
            } finally {
                release();
            }
        } finally {
            rerankActiveScoreRuns = Math.max(0, rerankActiveScoreRuns - 1);
        }
    }
}
