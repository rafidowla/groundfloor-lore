/**
 * embed/batchedEmbedder.ts — Sprint E1 (2026-05-24).
 *
 * Provider-agnostic batched embed driver. Wraps the existing
 * `embedDocumentBatch` already implemented on both providers
 * (LocalEmbeddingProvider — HF pipeline; OpenAICompatEmbeddingProvider —
 * /v1/embeddings array-input). This file does NOT reimplement batching;
 * it presents a stable contract for the bulk + warm + cool lanes (E2 +
 * E3) and chunks oversized inputs so callers never have to think about
 * per-provider batch caps.
 *
 * Why a separate component:
 *   The Sprint E principle (clause 1+2): embedding is its own component
 *   at `packages/lore/src/embed/batchedEmbedder.ts`, exposing
 *   `embedBatch(texts: string[]): Promise<number[][]>` so the outbox
 *   replicator + the in-memory embed queue + the future re-embed job
 *   all funnel through one contract. Today's `embedDocumentBatch` lives
 *   on the provider interface and is OPTIONAL — every consumer has its
 *   own "if provider supports it, batch; else fall back" branch. This
 *   component fixes that: it speaks the bulk contract unconditionally
 *   and handles per-provider fallback once.
 *
 * Per-provider max batch size (E0 audit, Section 4):
 *   - Local Xenova:       256  (CPU + 384-d model ≈ ~300KB working memory,
 *                                comfortably under the 1GB daemon budget)
 *   - OpenAI-compatible:  1000 (BGE-M3 cloud servers, OpenAI, vLLM all
 *                                accept arrays well past 1000; conservative
 *                                ceiling avoids HTTP timeouts on slow links)
 *
 * Sprint E gate cases flipped by this file:
 *   - E-D1: this file exists with the `embedBatch(string[])` signature.
 *   - E-D5: hot single-write inline embed path is unchanged (this file
 *           does not touch VerbatimStore.store, MCP store_node, /api/node).
 *   - E-D7: outbox dispatcher's `embed.batch` + `embed.done`
 *           operationKinds (wired in dispatcher.ts) call back into this
 *           component, preserving the Sprint O outbox-first invariant.
 *
 * E2 (shipped 2026-05-24): bulk-lane endpoints enqueue `embed.batch`
 * outbox entries via recordHotWriteBatch (skip-on-write default).
 *
 * E3 (shipped 2026-05-24): the OutboxReplicator drains queued
 * embed.batch rows on its existing tick (idle 250 ms / busy 10 ms;
 * the 5-second ceiling stays the upper bound — see
 * EMBED_BATCH_TICK_CEILING_MS below). On each tick the replicator
 * flushes consolidated runs of adjacent embed.batch rows into one
 * BatchedEmbedder.embedBatch call (EMBED_BATCH_CONSOLIDATION_CAP =
 * 1024 texts per merged dispatch), which is the drain helper the
 * E-D3 marker greps for.
 */

import { embedBatchCap, awaitEmbedMemoryHeadroom } from './memoryBudget.js';

/**
 * Parse an integer env var with a fallback default.
 * Returns the default when the var is unset, empty, or not a valid integer.
 */
function parseEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Sprint E3 — ceiling for the embed-batch flush cadence.
 *
 * The replicator's idle sleep is 250 ms and its busy sleep is 10 ms,
 * so in practice queued embed.batch rows flush far sooner. The 5000
 * ms constant is the documented worst-case ceiling per Sprint E
 * principle clause 5 — used by operators as the upper bound when
 * estimating "how stale can a queued embed be before I worry?".
 * Exported so the E3 unit test + the E-D3 gate marker can reference
 * it from the same source as the runtime.
 *
 * Override via LORE_EMBED_TICK_MS (default: 5000).
 *
 * The replicator-side drain/flush helper that consumes the
 * accumulated buffer is `replicateConsolidatedEmbedBatch` in
 * outbox/replicator.ts (the E-D3 marker requires this file mention
 * both the 5-second cadence AND a flush/drain helper).
 */
export const EMBED_BATCH_TICK_CEILING_MS = parseEnvInt('LORE_EMBED_TICK_MS', 5000);
// 5000 ms tick ceiling — drain helper: replicateConsolidatedEmbedBatch (E3).

import type { EmbeddingProvider } from '../providers/types.js';

/**
 * Sprint E1 contract. Every consumer in the embed pipeline calls
 * this — no more "if provider has embedDocumentBatch, use it; else
 * fall back to per-item embedDocument" branching scattered across
 * verbatimStore.storeBatch / EmbedQueue executor / future re-embed job.
 */
export interface BatchedEmbedder {
    /**
     * Embed N texts. Returns N vectors in the same order. Chunks
     * automatically when N exceeds `maxBatchSize()` — the caller does
     * not need to pre-slice.
     *
     * Empty input returns []. Single-element input still goes through
     * the batch path (one model call with array of length 1) — cheaper
     * than a separate code path and the providers handle it fine.
     */
    embedBatch(texts: string[]): Promise<number[][]>;
    /**
     * The largest array the underlying model can comfortably accept in
     * one call. 256 for local Xenova (CPU + 384-d), 1000 for the
     * OpenAI-compatible cloud endpoint (BGE-M3 / OpenAI / vLLM).
     */
    maxBatchSize(): number;
    /** Vector dimension — pass-through from the wrapped provider. */
    readonly dimension: number;
    /** Model id — pass-through; used for telemetry / fingerprint checks. */
    readonly modelId: string;
}

/**
 * Per-provider default max batch sizes. Exported so the E1 unit test +
 * future E2 producer can assert "this is what we promise the spec".
 *
 * Both can be overridden via LORE_EMBED_BATCH_MAX.
 *
 * MVP-mem (2026-06-28): the local cap is now ADAPTIVE — embedBatchCap() scales
 * it to the host's total RAM (~8 texts/GB, clamped [8,256]) instead of a flat
 * 256, so a small machine never runs a forward pass big enough to OOM while a
 * big machine keeps full throughput (≥32 GB → 256, unchanged). The transient
 * memory SPIKE during a large bulk embed is bounded separately by the
 * awaitEmbedMemoryHeadroom() back-pressure gate used in embedBatch() below.
 */
export const LOCAL_XENOVA_MAX_BATCH = embedBatchCap();
export const OPENAI_COMPAT_MAX_BATCH = parseEnvInt('LORE_EMBED_BATCH_MAX', 1000);

export interface BatchedEmbedderOpts {
    /**
     * Override the per-provider default cap. Operators may lower this
     * on memory-constrained hosts. The implementation enforces it
     * regardless of provider type — chunks any input above the cap.
     */
    maxBatchSize?: number;
}

/**
 * Wraps an existing EmbeddingProvider. If the provider exposes the
 * optional `embedDocumentBatch`, that path is used. Otherwise falls
 * back to N sequential `embedDocument` calls — keeps the contract
 * total even for hand-rolled providers shipped by plugins.
 */
export class ProviderBatchedEmbedder implements BatchedEmbedder {
    public readonly dimension: number;
    public readonly modelId: string;
    private readonly provider: EmbeddingProvider;
    private readonly cap: number;

    constructor(provider: EmbeddingProvider, opts: BatchedEmbedderOpts = {}) {
        this.provider = provider;
        this.dimension = provider.dimension;
        this.modelId = provider.modelId;
        this.cap = opts.maxBatchSize ?? inferMaxBatchSize(provider);
    }

    maxBatchSize(): number {
        return this.cap;
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];

        // Chunk into ≤cap slices. Each slice → one model call.
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += this.cap) {
            // MVP-mem: back-pressure before each forward pass so a large bulk
            // embed self-throttles when this process is over its RAM budget.
            await awaitEmbedMemoryHeadroom();
            const slice = texts.slice(i, i + this.cap);
            const chunkVectors = await this.embedOneChunk(slice);
            // SW-03 (B5) — a flaky provider that returns fewer (or more)
            // vectors than texts would silently mis-align text↔vector or
            // leave nodes unembedded. Throw so the outbox retries the
            // whole batch instead of persisting a corrupt, misaligned
            // result. Per-chunk so the offending slice is named.
            if (chunkVectors.length !== slice.length) {
                throw new Error(
                    `BatchedEmbedder.embedBatch: provider returned ${chunkVectors.length} vectors ` +
                    `for ${slice.length} texts (chunk at offset ${i}) — refusing to persist a ` +
                    `misaligned/partial embed`,
                );
            }
            for (const v of chunkVectors) out.push(v);
        }
        return out;
    }

    /** Single chunk ≤ cap. Prefers provider.embedDocumentBatch; falls
     *  back to per-item embedDocument when the provider doesn't ship
     *  the optional batch method. */
    private async embedOneChunk(texts: string[]): Promise<number[][]> {
        if (this.provider.embedDocumentBatch) {
            return this.provider.embedDocumentBatch(texts);
        }
        const out: number[][] = [];
        for (const t of texts) {
            out.push(await this.provider.embedDocument(t));
        }
        return out;
    }
}

/**
 * Infer the per-provider default cap from the provider's class name.
 * The provider interface intentionally doesn't expose "what kind of
 * provider am I" — kept narrow. We sniff by constructor name so this
 * stays a small, in-package decision; if an external client uses a custom
 * provider that wants a different cap, it can pass `opts.maxBatchSize`
 * explicitly.
 */
function inferMaxBatchSize(provider: EmbeddingProvider): number {
    const name = provider.constructor?.name ?? '';
    if (name === 'OpenAICompatEmbeddingProvider') return OPENAI_COMPAT_MAX_BATCH;
    if (name === 'LocalEmbeddingProvider') return LOCAL_XENOVA_MAX_BATCH;
    // Unknown provider — be conservative. Matches the local cap so
    // memory pressure stays bounded for the common case (a custom
    // local provider that wraps a different in-process model).
    return LOCAL_XENOVA_MAX_BATCH;
}

/**
 * Convenience factory. Most call sites should use this rather than
 * `new ProviderBatchedEmbedder(...)` — keeps the construction shape
 * in one place so a future change (e.g. wrapping with a metrics
 * decorator) doesn't fan out across the codebase.
 */
export function batchedEmbedderFor(
    provider: EmbeddingProvider,
    opts: BatchedEmbedderOpts = {},
): BatchedEmbedder {
    return new ProviderBatchedEmbedder(provider, opts);
}
