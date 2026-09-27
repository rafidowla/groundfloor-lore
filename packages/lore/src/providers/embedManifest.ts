/**
 * embedManifest.ts — Lore 3.24 D9 Part A (shared embedding cache, O1). Pinned
 * revision + sha256 manifest for the DEFAULT local embedding model at the
 * DEFAULT dtype. Mirrors rerankManifest.ts's role for the re-rank feature —
 * see docs/design/D9-shared-model-server.md §3 build step 3.
 *
 * Only the default model (`DEFAULT_EMBED_MODEL_ID`, which matches
 * localEmbeddingProvider.ts's `DEFAULT_LOCAL_MODEL_ID` — asserted equal by
 * test/embed-model-cache-fixtures-unit.ts, exactly like rerankManifest.ts /
 * localRerankProvider.ts's duplicated-literal + unit-test-equality pattern)
 * at `q8` is pinned and hash-verified. A non-default model or dtype still
 * goes through the shared cache (marker-gated, staged/verified/renamed) but
 * gets no sha256 manifest coverage — documented in docs/CONFIGURATION.md.
 *
 * `DEFAULT_EMBED_REVISION` and every hash below were captured 2026-09-25
 * from `https://huggingface.co/Xenova/multilingual-e5-small`: one read-only
 * GET to `/api/models/...` for the current commit sha, then the same 4 files
 * downloaded directly at that pinned revision and hashed locally with
 * `shasum -a 256` — the result matched the legacy transformers.js cache
 * already present in `node_modules/@huggingface/transformers/.cache/Xenova/
 * multilingual-e5-small/` byte-for-byte, so that revision is pinned as-is
 * (no mismatch to report — see D9 §3 build step 3's fallback branch, not
 * needed here).
 *
 * `DEFAULT_LOCAL_MODEL_ID` in localEmbeddingProvider.ts type-imports
 * `ModelDtype` FROM this file's sibling constants below via that module —
 * to avoid a runtime import cycle (localEmbeddingProvider.ts needs to
 * runtime-import modelCache.ts, which needs this file), this file keeps its
 * own literal copy of the default model id rather than importing it back.
 */

import type { ModelDtype } from './localEmbeddingProvider.js';

/** Duplicated literal — see file header. Must stay equal to
 *  localEmbeddingProvider.ts's `DEFAULT_LOCAL_MODEL_ID`; asserted by a unit
 *  test. */
export const DEFAULT_EMBED_MODEL_ID = 'Xenova/multilingual-e5-small';

/** The dtype the manifest below covers. Non-default dtypes of the default
 *  model still use the shared cache, just without hash verification. */
export const DEFAULT_EMBED_MANIFEST_DTYPE: ModelDtype = 'q8';

export const DEFAULT_EMBED_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';

/** The 4 files the runtime actually loads for `q8` (confirmed cache layout —
 *  flat `<modelDir>/{config.json,tokenizer.json,tokenizer_config.json,
 *  onnx/model_quantized.onnx}`, matching the legacy transformers.js cache
 *  layout under `node_modules/@huggingface/transformers/.cache/...`).
 *  `vocab.txt`/`special_tokens_map.json` are present upstream but not
 *  required by a fast-tokenizer load from `tokenizer.json`, so they are
 *  neither fetched nor manifested (same rationale as rerankManifest.ts). */
export const DEFAULT_EMBED_MANIFEST: Readonly<Record<string, string>> = Object.freeze({
    'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
    'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
    'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
});

/** Maps dtype -> the ONNX filename inside `onnx/` that Transformers.js loads
 *  for that dtype. Used both by the resolver (modelCache.ts — what file must
 *  be present for a given dtype to count as "cached") and by `lore models
 *  fetch-embedding` (what to expect after download). */
export const EMBED_DTYPE_ONNX_FILE: Readonly<Record<ModelDtype, string>> = Object.freeze({
    fp32: 'model.onnx',
    fp16: 'model_fp16.onnx',
    q8: 'model_quantized.onnx',
    q4: 'model_q4.onnx',
});

/** The non-onnx files every dtype needs alongside its dtype-specific ONNX
 *  file. */
export const EMBED_COMMON_FILES: readonly string[] = Object.freeze([
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
]);
