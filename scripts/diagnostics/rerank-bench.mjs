#!/usr/bin/env node
/**
 * scripts/diagnostics/rerank-bench.mjs — D8b (Lore 3.23), design
 * DESIGN-3.23.md §7 item 5: RSS and latency measurement for the optional
 * local cross-encoder re-rank stage. D8-owned (never touched by D7).
 *
 * Per the design doc, verbatim:
 *   "It records process.memoryUsage().rss before the first rerank, after
 *   the model loads, and after 100 queries at K=10. It reports
 *   rerank-stage p50/p90 and first-call load time, plus K=5 and K=20 for
 *   context. The simulation reference is +~330 MB and ~0.3 s."
 *
 * D8c (2026-09-25) fix: the original fixture here built ONE short (~200
 * char) synthetic passage per candidate and drove
 * `LocalRerankProvider.score()` directly — skipping `rerankStage.ts`'s
 * piece construction entirely. Against Atlas's real node bodies (measured
 * separately via a scratch harness — see $SP/evidence/d8c/memory-matrix.md
 * — median 2725 / p90 4402 chars, ~37-41 pieces/query at K=10, max_length
 * 320) that under-measured both RSS growth and latency by a wide margin:
 * this script previously reported +271.4MB / p50 21.5ms at K=10, while the
 * real-body harness measured a ~1300MB plateau and p50 ~271ms for the same
 * K=10 workload. This script now (a) generates synthetic candidate BODIES
 * whose length distribution matches that measured real distribution
 * (`sampleBodyLen`, piecewise-linear over p10/p50/p90/p99/max) instead of
 * one short passage per candidate, and (b) drives the real
 * `applyRerankStage()` (real piece windowing/stride/caps, real margin
 * gate) instead of calling `LocalRerankProvider.score()` directly, so the
 * reported latency/RSS reflect the full production rerank stage, not just
 * the model forward pass. It remains a SYNTHETIC-text bench (no real node
 * corpus needed to run) — the real-body numbers are the authoritative
 * measurement, recorded in CHANGELOG.md's D8 subsection and
 * $SP/evidence/d8c/memory-matrix.md; this script's job is to give any
 * future session a repeatable, self-contained regression check that is at
 * least realistic in scale.
 *
 * Drives `applyRerankStage()` (the same function `recall/rerankStage.ts`'s
 * `applyRerankStageIfEnabled` calls on the retrieve() hot path) with a
 * real `LocalRerankProvider` as the scorer, over synthetic
 * `RetrievalResult[]` candidates — so the reported latency is the rerank
 * stage itself (piece construction + forward pass + margin gate) — not
 * BM25/vector retrieval/graph-traversal overhead ahead of it.
 *
 * Requires the model already cached (`lore models fetch-rerank` — see
 * cli/commands/modelsFetch.ts; this script never passes
 * `local_files_only:false`, matching every other rerank-stage caller) —
 * point `LORE_HOME` at wherever that command downloaded it before running
 * this.
 *
 * Self re-execs with --expose-gc + --import tsx, same pattern as
 * scripts/diagnostics/embed-release-measure.mjs.
 *
 * MEASUREMENT ONLY. Nothing here edits packages/lore/src/**.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');

if (typeof globalThis.gc !== 'function') {
    const res = spawnSync(
        process.execPath,
        ['--expose-gc', '--import', 'tsx', SELF, ...process.argv.slice(2)],
        { stdio: 'inherit', cwd: REPO_ROOT, env: process.env },
    );
    process.exit(res.status ?? 1);
}
const gc = globalThis.gc;

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const JSON_OUT = argOf('--json', null);
const QUERIES_AT_K10 = Number.parseInt(argOf('--queries', '100'), 10);
/** Rep count for the K=5/K=20 "for context" latency samples — smaller
 *  than the mandated 100-at-K=10, since these two are context, not the
 *  headline figure. */
const CONTEXT_REPS = Number.parseInt(argOf('--context-reps', '30'), 10);

const MB = 1024 * 1024;
const toMb = (b) => b / MB;

function vmmapFootprintMb(pid) {
    if (process.platform !== 'darwin') return null;
    try {
        const out = execFileSync('vmmap', ['--summary', String(pid)], {
            encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        const m = /Physical footprint:\s+([\d.]+)([KMG])/.exec(out);
        if (!m) return null;
        const value = Number.parseFloat(m[1]);
        const mult = m[2] === 'G' ? 1024 : m[2] === 'K' ? 1 / 1024 : 1;
        return value * mult;
    } catch {
        return null;
    }
}

function sample(label) {
    try { gc(); } catch { /* --expose-gc is guaranteed present here */ }
    const mu = process.memoryUsage();
    const s = {
        label,
        rssMb: toMb(mu.rss),
        heapUsedMb: toMb(mu.heapUsed),
        vmmapFootprintMb: vmmapFootprintMb(process.pid),
    };
    console.log(`[rerank-bench] ${label}: rss=${s.rssMb.toFixed(1)}MB heapUsed=${s.heapUsedMb.toFixed(1)}MB vmmap=${s.vmmapFootprintMb == null ? 'n/a' : s.vmmapFootprintMb.toFixed(1) + 'MB'}`);
    return s;
}

function percentile(sortedAsc, p) {
    if (sortedAsc.length === 0) return null;
    const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
    return sortedAsc[idx];
}

function makeQuery(tag) {
    return `How does the ${tag} subsystem handle retry and backoff under load?`;
}

/** Deterministic PRNG (mulberry32) — reproducible body-length/content
 *  sampling across runs and machines, no external dependency. */
function mulberry32(seed) {
    let s = seed | 0;
    return function rng() {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Content-length percentile table measured from Atlas's real recall
 *  candidates (198-query candidate set, top-10 cands/query, 2026-09-25 —
 *  see $SP/evidence/d8c/memory-matrix.md): p10=1272, p50=2725, p90=4402,
 *  p99=5292, max=5292 chars. Piecewise-linear sampler over this table
 *  reproduces realistic piece counts (~35-40 pieces/query at K=10 with
 *  the production 1000-char/800-stride window) without needing the real
 *  corpus at bench time. */
const BODY_LEN_PERCENTILES = [
    [0, 400], [10, 1272], [50, 2725], [90, 4402], [99, 5292], [100, 5292],
];
function sampleBodyLen(u) {
    const p = u * 100;
    for (let i = 1; i < BODY_LEN_PERCENTILES.length; i++) {
        const [p0, v0] = BODY_LEN_PERCENTILES[i - 1];
        const [p1, v1] = BODY_LEN_PERCENTILES[i];
        if (p <= p1) {
            const t = p1 === p0 ? 0 : (p - p0) / (p1 - p0);
            return Math.round(v0 + t * (v1 - v0));
        }
    }
    return BODY_LEN_PERCENTILES[BODY_LEN_PERCENTILES.length - 1][1];
}

/** Cycling sentence pool — original filler text about this very feature,
 *  varied enough that tokenization isn't a degenerate single-token
 *  repeat, unlike a naive `"x".repeat(n)` fixture. */
const SENTENCE_POOL = [
    'The retrieval pipeline fuses BM25 and vector similarity via reciprocal-rank fusion before graph traversal expands direct matches into neighbours.',
    'A local cross-encoder re-rank stage optionally reorders the top K candidates by scoring each against the query with a small quantized model.',
    'Nodes carry a label, a content body, tags, and workspace-scoped metadata that downstream consumers use to calibrate relevance.',
    'Configuration is resolved per-call, then per-workspace, then from the process environment, with an explicit default as the final fallback.',
    'Failure modes are designed to fail open: a missing model, a timeout, or a scoring error all leave the original ranked order untouched.',
    'Margin-gated reordering prevents a marginally higher-scoring candidate from displacing a strong incumbent at the top of the result set.',
    'Piece construction splits each candidate body into overlapping windows so a long document is scored by its most relevant excerpt.',
    'The daemon caches a loaded model in memory and unloads it after an idle period to bound steady-state resident memory.',
    'Recall surfaces this behaviour identically across the MCP tool, the REST API, and the in-process client used by embedded hosts.',
    'Benchmark harnesses measure both latency percentiles and resident memory growth across a realistic query and passage workload.',
];
function makeBody(targetLen, rng) {
    let out = '';
    let i = Math.floor(rng() * SENTENCE_POOL.length);
    while (out.length < targetLen) {
        out += (out ? ' ' : '') + SENTENCE_POOL[i % SENTENCE_POOL.length];
        i++;
    }
    return out.slice(0, targetLen);
}

/** Build `k` synthetic `RetrievalResult`-shaped candidates whose
 *  `node.content` length distribution matches the real measured
 *  distribution above, so `applyRerankStage`'s piece construction
 *  produces a realistic piece count per query (not one short passage per
 *  candidate). `seedBase` makes each call's bodies deterministic but
 *  distinct from other calls. */
function buildCandidates(k, tag, seedBase) {
    const rng = mulberry32(seedBase);
    return Array.from({ length: k }, (_, i) => {
        const len = sampleBodyLen(rng());
        const node = {
            id: `rerank-bench-${tag}-${i}`,
            type: 'knowledge',
            label: `Synthetic node ${tag}-${i}`,
            content: makeBody(len, rng),
            tags: ['rerank-bench'],
            project: 'rerank-bench',
            ecosystem: 'rerank-bench',
            metadata: '{}',
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            syncedAt: null,
        };
        return { node, score: 1 - i * 0.01, matchedBy: ['semantic'], depth: 0, source: 'seed' };
    });
}

async function main() {
    const rerankConfigMod = await import(path.join(REPO_ROOT, 'packages/lore/src/recall/rerankConfig.ts'));
    const { DEFAULT_RERANK_MODEL, DEFAULT_RERANK_DTYPE, DEFAULT_RERANK_MARGIN, DEFAULT_RERANK_TIMEOUT_MS } = rerankConfigMod;
    const { loreHomePath } = await import(path.join(REPO_ROOT, 'packages/lore/src/config/loreHome.ts'));
    const { LocalRerankProvider, rerankModelCached } =
        await import(path.join(REPO_ROOT, 'packages/lore/src/providers/localRerankProvider.ts'));
    const { applyRerankStage } = await import(path.join(REPO_ROOT, 'packages/lore/src/recall/rerankStage.ts'));

    const modelId = argOf('--model', DEFAULT_RERANK_MODEL);
    const dtype = argOf('--dtype', DEFAULT_RERANK_DTYPE);
    const cacheDir = loreHomePath('models');

    console.log('');
    console.log('rerank-bench (D8c — real applyRerankStage, synthetic full-node bodies)');
    console.log(`  Model:       ${modelId}`);
    console.log(`  Dtype:       ${dtype}`);
    console.log(`  Cache dir:   ${cacheDir}`);
    console.log(`  Queries@K10: ${QUERIES_AT_K10}`);
    console.log(`  Context reps (K=5, K=20): ${CONTEXT_REPS}`);
    console.log('');

    if (!rerankModelCached(modelId, dtype, cacheDir)) {
        console.error(`rerank-bench: model "${modelId}" is not cached under ${cacheDir}.`);
        console.error('Run `lore models fetch-rerank` first (see cli/commands/modelsFetch.ts) — this');
        console.error('script deliberately never downloads (local_files_only:true throughout).');
        process.exit(1);
    }

    const provider = new LocalRerankProvider({ modelId, dtype, cacheDir });
    /** scorer seam applyRerankStage expects — same shape rerankStage.ts's
     *  applyRerankStageIfEnabled supplies in production. */
    const scorer = (query, passages) => provider.score(query, passages);
    const samples = [];
    let seedCounter = 1;

    samples.push(sample('1-before-first-rerank'));

    // First-call load time: the very first applyRerankStage() call pays
    // for tokenizer/model from_pretrained() (acquireProvider's
    // single-flight load) PLUS real piece construction over K=10
    // realistic-length candidates — same lazy-load + piece-build path a
    // cold production process takes on its first rerank:true request.
    const firstQuery = makeQuery('warmup');
    const firstCandidates = buildCandidates(10, 'warmup', seedCounter++);
    const cfgFor = (k) => ({
        enabled: true, model: modelId, dtype, k, margin: DEFAULT_RERANK_MARGIN, timeoutMs: DEFAULT_RERANK_TIMEOUT_MS,
    });
    const loadStart = performance.now();
    const firstOutcome = await applyRerankStage(firstCandidates, firstQuery, cfgFor(10), scorer);
    const firstCallLoadMs = performance.now() - loadStart;
    console.log(`[rerank-bench] first-call load time: ${firstCallLoadMs.toFixed(1)}ms (pieces=${firstOutcome.meta.piecesScored})`);

    samples.push(sample('2-after-model-loads'));

    /** Run `reps` independent applyRerankStage() calls at width K, return
     *  the sorted per-call latencies in ms plus the piecesScored seen at
     *  each call (for the reported pieces/query context). Each call is a
     *  fresh (query, K candidates) pair with freshly-sampled body lengths
     *  so both tokenization/forward-pass cost and piece count are
     *  representative of real recall hits, not a degenerate fixed case. */
    async function runLatencyReps(k, reps, tag) {
        const latencies = [];
        const pieceCounts = [];
        for (let i = 0; i < reps; i++) {
            const query = makeQuery(`${tag}-${i}`);
            const candidates = buildCandidates(k, `${tag}-${i}`, seedCounter++);
            const t0 = performance.now();
            const { meta } = await applyRerankStage(candidates, query, cfgFor(k), scorer);
            latencies.push(performance.now() - t0);
            pieceCounts.push(meta.piecesScored);
        }
        latencies.sort((a, b) => a - b);
        pieceCounts.sort((a, b) => a - b);
        return { latencies, pieceCounts };
    }

    // Headline: 100 queries at K=10 — both the mandated memory checkpoint
    // ("after 100 queries at K=10") and the K=10 p50/p90 figure.
    const k10 = await runLatencyReps(10, QUERIES_AT_K10, 'k10');
    samples.push(sample('3-after-100-queries-at-k10'));

    // Context: K=5 and K=20 at a smaller rep count.
    const k5 = await runLatencyReps(5, CONTEXT_REPS, 'k5');
    const k20 = await runLatencyReps(20, CONTEXT_REPS, 'k20');

    const stageLatency = {
        k5: { reps: k5.latencies.length, p50Ms: percentile(k5.latencies, 50), p90Ms: percentile(k5.latencies, 90) },
        k10: { reps: k10.latencies.length, p50Ms: percentile(k10.latencies, 50), p90Ms: percentile(k10.latencies, 90) },
        k20: { reps: k20.latencies.length, p50Ms: percentile(k20.latencies, 50), p90Ms: percentile(k20.latencies, 90) },
    };
    const piecesPerQueryK10 = { p50: percentile(k10.pieceCounts, 50), p90: percentile(k10.pieceCounts, 90) };

    console.log('');
    console.log('rerank-stage latency (ms) — via real applyRerankStage, synthetic full-node bodies:');
    for (const [k, v] of Object.entries(stageLatency)) {
        console.log(`  ${k.padEnd(4)} reps=${String(v.reps).padEnd(4)} p50=${v.p50Ms.toFixed(1).padStart(7)}  p90=${v.p90Ms.toFixed(1).padStart(7)}`);
    }
    console.log(`  pieces/query @K10: p50=${piecesPerQueryK10.p50} p90=${piecesPerQueryK10.p90} (real Atlas data measured ~37-41 for this K/window/stride — see $SP/evidence/d8c/memory-matrix.md)`);
    console.log('');
    console.log('RSS deltas vs baseline (design reference: +~330 MB simulation; D8c measured +~483-486MB against real full-node bodies — see CHANGELOG.md D8 subsection):');
    const baselineRss = samples[0].rssMb;
    for (const s of samples) {
        console.log(`  ${s.label.padEnd(28)} rss=${s.rssMb.toFixed(1)}MB (+${(s.rssMb - baselineRss).toFixed(1)}MB)`);
    }
    console.log('');

    const result = {
        modelId,
        dtype,
        cacheDir,
        queriesAtK10: QUERIES_AT_K10,
        contextReps: CONTEXT_REPS,
        firstCallLoadMs,
        samples,
        stageLatency,
        piecesPerQueryK10,
    };
    if (JSON_OUT) {
        const fs = await import('node:fs');
        fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
        console.log(`[rerank-bench] wrote ${JSON_OUT}`);
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
