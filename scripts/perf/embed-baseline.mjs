// scripts/perf/embed-baseline.mjs — Sprint E0 raw embed throughput probe.
//
// Measures @huggingface/transformers default model
// (Xenova/multilingual-e5-small) per-item vs single-call batched
// throughput on 100 representative passages. No I/O — just the embed
// path. Used to anchor SPRINT_E_PRE_BASELINE_RAW_EMBED_* constants
// in test/sprint-E-embed-property.ts and the numbers in
// docs/audits/sprint-E-embed-2026-05-24.md Section 4.
//
// Run from a directory where @huggingface/transformers resolves
// (e.g. inside packages/lore/):
//
//   cd packages/lore && node ../../scripts/perf/embed-baseline.mjs
//
// Live-daemon end-to-end measurement (POST /api/node × 100 + bulk × 1000)
// was attempted at E0 audit time but blocked by global outbox-lag
// backpressure on the default workspace. Deferred to E1 with a clean
// workspace per the scope guard documented in the audit.

import { pipeline } from '@huggingface/transformers';

const modelId = 'Xenova/multilingual-e5-small';
console.log(`[bench] loading ${modelId}…`);
const t0 = Date.now();
const embed = await pipeline('feature-extraction', modelId);
console.log(`[bench] loaded in ${Date.now() - t0}ms`);

const texts = Array.from({ length: 100 }, (_, i) =>
    `passage: probe-${i} this is a sample text of moderate length representing typical Lore node content used to measure embedding throughput baseline before Sprint E batching.`
);

// Warm up so the first per-item iteration isn't biased by cold caches.
await embed(texts[0], { pooling: 'mean', normalize: true });

const s1 = Date.now();
for (const t of texts) {
    await embed(t, { pooling: 'mean', normalize: true });
}
const perItemMs = Date.now() - s1;
console.log(`[bench] per-item x100: ${perItemMs} ms (${(perItemMs / 100).toFixed(1)} ms/embed, ${(100000 / perItemMs).toFixed(1)} embed/s)`);

const s2 = Date.now();
await embed(texts, { pooling: 'mean', normalize: true });
const batchMs = Date.now() - s2;
console.log(`[bench] batched x100 (single call): ${batchMs} ms (${(100000 / batchMs).toFixed(1)} embed/s, ${(perItemMs / batchMs).toFixed(2)}x speedup)`);
