/**
 * rerankManifest.ts — D8d (Lore 3.23 security hardening): pinned revision +
 * sha256 manifest for the DEFAULT re-rank model at the DEFAULT dtype. See
 * $SP/SECURITY-D8.md F4/F5.
 *
 * Only the default model (`DEFAULT_RERANK_MODEL` from rerankConfig.ts) at
 * `q8` is pinned and hash-verified — that is the one `lore models
 * fetch-rerank` downloads with no `--model`/`--dtype` flags, and the one
 * DESIGN-3.23.md ships as the out-of-the-box re-rank model. An operator who
 * points `LORE_RECALL_RERANK_MODEL` / `set-rerank --model` at a different id
 * gets no manifest coverage (documented in docs/CONFIGURATION.md) — the
 * `.complete` marker `fetchRerankCommand` writes is still required before
 * `rerankModelCached()` will treat any model (default or not) as usable, but
 * only the default model's file contents are hash-verified against a known
 * value.
 *
 * `DEFAULT_RERANK_REVISION` and every hash below were captured 2026-09-25
 * from `https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2` (one read-only
 * GET to `/api/models/...` for the commit sha, then the 4 files fetched
 * directly at that pinned revision and hashed locally with `shasum -a 256`
 * — see $SP/handoff-d8d.md for the exact commands).
 */

import type { RerankDtype } from './localRerankProvider.js';

export const DEFAULT_RERANK_REVISION = 'a09144355adeed5f58c8ed011d209bf8ee5a1fec';

/** The 4 files the runtime actually loads for `q8` (confirmed cache layout
 *  — D8c's flat `<modelDir>/{config.json,tokenizer.json,tokenizer_config.json,
 *  onnx/model_quantized.onnx}`). `vocab.txt`/`special_tokens_map.json` are
 *  present upstream but not required by a fast-tokenizer load from
 *  `tokenizer.json`, so they are neither fetched nor manifested. */
export const DEFAULT_RERANK_MANIFEST: Readonly<Record<string, string>> = Object.freeze({
    'config.json': 'd827779a72d27ae68cf878a6fc2e954542663fe21ca515d9f4783fc96be2d37e',
    'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
    'tokenizer_config.json': '0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53',
    'onnx/model_quantized.onnx': 'e9d8ebf845c413e981c175bfe49a3bfa9b3dcce2a3ba54875ee5df5a58639fbe',
});

/** Maps dtype -> the ONNX filename inside `onnx/` that Transformers.js loads
 *  for that dtype (per the HF repo's `siblings` listing). Used both by
 *  `fetchRerankCommand` (what to expect after download) and
 *  `rerankModelCached` (which exact file must be present for a given
 *  dtype — F5's "loose check doesn't match the dtype-specific file"). */
export const RERANK_DTYPE_ONNX_FILE: Readonly<Record<RerankDtype, string>> = Object.freeze({
    fp32: 'model.onnx',
    fp16: 'model_fp16.onnx',
    q8: 'model_quantized.onnx',
    q4: 'model_q4.onnx',
});

/** The non-onnx files every dtype needs alongside its dtype-specific ONNX
 *  file. */
export const RERANK_COMMON_FILES: readonly string[] = Object.freeze([
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
]);
