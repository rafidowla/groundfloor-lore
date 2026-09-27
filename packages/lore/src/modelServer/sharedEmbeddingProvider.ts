/**
 * modelServer/sharedEmbeddingProvider.ts — Lore 3.24 slice C2a.
 *
 * `EmbeddingProvider` implementation backed by a `ModelServerClient`
 * instead of an in-process Xenova pipeline. `modelId`/`dtype`/`dimension`/
 * `maxBatchSize` are copied verbatim from a `LocalEmbeddingProvider`
 * instance constructed with the SAME options this provider would otherwise
 * have used — so the fingerprint (`embeddingProviderFingerprint()`) and
 * batch-size behavior are indistinguishable from local mode to every
 * downstream consumer (vector store schema, `batchedEmbedder.ts`).
 *
 * On a `ModelServerUnavailableError` from the client (fallback mode), every
 * method transparently delegates to that same local provider instance —
 * lazily initialized on first actual use, not at construction, so a host
 * that never falls back never pays the local model's load cost. This is
 * the ONLY fallback path: this class never surfaces
 * `ModelServerUnavailableError` to its own callers.
 */

import { LocalEmbeddingProvider, type LocalEmbeddingProviderOptions, releaseLocalEmbeddingPipeline } from '../providers/localEmbeddingProvider.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { ModelServerClient, ModelServerUnavailableError } from './client.js';
import { ModelServerError } from './protocol.js';

/**
 * SF11 (3.24 review): retry schedule for a per-client `busy` rejection
 * (the server's per-connection embed queue is full — see connection.ts's
 * `queueMaxPerClient`). Bounded — 5 attempts, ~3.1s total — so a sustained
 * `busy` condition still resolves (falls back in-process, see
 * `callWithBusyRetry`) rather than waiting forever.
 */
const BUSY_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600];

/**
 * SF10 (3.24 review): retry schedule for `releaseFallback()` finding its
 * pipeline still `inFlight` (see the doc comment on that method). ~15.75s
 * total — comfortably above the slowest cold-load-then-embed runtime
 * observed for the default local model in this codebase's own tests
 * (~7s), with margin for a loaded machine.
 */
const RELEASE_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SharedEmbeddingProviderOptions extends LocalEmbeddingProviderOptions {
    client: ModelServerClient;
    log?: { info?(msg: string, ctx?: Record<string, unknown>): void };
}

export class SharedEmbeddingProvider implements EmbeddingProvider {
    readonly dimension: number;
    readonly modelId: string;
    readonly dtype?: string;
    readonly maxBatchSize?: number;

    private readonly client: ModelServerClient;
    private readonly localOpts: LocalEmbeddingProviderOptions;
    private readonly log?: { info?(msg: string, ctx?: Record<string, unknown>): void };
    private localFallback: LocalEmbeddingProvider | null = null;

    constructor(opts: SharedEmbeddingProviderOptions) {
        this.client = opts.client;
        this.localOpts = { modelId: opts.modelId, dimension: opts.dimension, device: opts.device, dtype: opts.dtype };
        this.log = opts.log;
        // Cheap: LocalEmbeddingProvider's constructor does no I/O — the
        // actual model load is lazy inside acquirePipeline(), triggered
        // only if/when this instance is actually used as a fallback.
        const shape = new LocalEmbeddingProvider(this.localOpts);
        this.dimension = shape.dimension;
        this.modelId = shape.modelId;
        this.dtype = shape.dtype;
        this.maxBatchSize = shape.maxBatchSize;
    }

    private fallback(): LocalEmbeddingProvider {
        if (!this.localFallback) this.localFallback = new LocalEmbeddingProvider(this.localOpts);
        return this.localFallback;
    }

    /**
     * SF10 (3.24 review, D9 §5.5.3): called by `applicability.ts`'s
     * `attachModelServer()` when the client's `onStatus` reports a
     * fallback→shared recovery. Drops this instance's own local-fallback
     * reference AND releases the shared module-level pipeline cache in
     * `localEmbeddingProvider.ts` (refcounted — a no-op if some other host
     * in this process is still using that same model/device/dtype).
     * Idempotent; safe to call when no fallback was ever created.
     *
     * `releaseLocalEmbeddingPipeline()` deliberately skips an entry that is
     * still `inFlight` (a call issued just before recovery was detected can
     * still be running against it — see localEmbeddingProvider.ts). This
     * method already dropped its own reference by the time that happens, so
     * without a retry the pipeline would sit resident forever: nothing else
     * re-triggers a release, since `onStatus` only fires again on the NEXT
     * mode transition, which may never come. `attemptPipelineRelease` below
     * retries with a short bounded backoff instead, covering the in-flight
     * call's remaining runtime (observed up to ~7s for a cold model load in
     * this codebase's own tests).
     */
    releaseFallback(): void {
        if (!this.localFallback) return;
        this.localFallback = null;
        this.attemptPipelineRelease(0);
    }

    private attemptPipelineRelease(attempt: number): void {
        const released = releaseLocalEmbeddingPipeline();
        if (released || attempt >= RELEASE_RETRY_DELAYS_MS.length) {
            this.log?.info?.('shared model server recovered — released in-process fallback embedding model', {
                modelId: this.modelId,
                pipelineReleased: released,
            });
            return;
        }
        setTimeout(() => this.attemptPipelineRelease(attempt + 1), RELEASE_RETRY_DELAYS_MS[attempt]).unref?.();
    }

    /**
     * SF11: retries a `busy` rejection (per-client embed queue full) with a
     * bounded backoff before giving up and falling back in-process for that
     * one call — the parity rule requires shared mode to still SUCCEED, not
     * throw, so the caller only reaches the fallback if every retry also
     * hit `busy`.
     */
    private async callWithBusyRetry<T>(fn: () => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (err) {
                const isBusy = err instanceof ModelServerError && err.code === 'busy';
                if (!isBusy || attempt >= BUSY_RETRY_DELAYS_MS.length) throw err;
                this.log?.info?.('shared model server busy — retrying', { attempt: attempt + 1, delayMs: BUSY_RETRY_DELAYS_MS[attempt] });
                await sleep(BUSY_RETRY_DELAYS_MS[attempt]);
            }
        }
    }

    /**
     * SF11: `too_large`/exhausted-`busy` errors both mean "shared mode
     * can't serve this call right now" without meaning the connection is
     * down — unlike `ModelServerUnavailableError`, `client.ts` does not
     * already fall back for these. Falling back here (in-process, via the
     * lazily-loaded local provider) is what makes shared mode match
     * in-process behavior for every input in-process accepts: in-process
     * has no hard char limit (silent ~512-token truncation only, see
     * localEmbeddingProvider.ts), so computing this one call in-process
     * reproduces that behavior exactly rather than approximating it.
     */
    private isParityFallbackError(err: unknown): boolean {
        return err instanceof ModelServerError && (err.code === 'too_large' || err.code === 'busy');
    }

    /**
     * SF11 (3.24 review, D9 §5.5.3 decision): the too_large/exhausted-busy
     * fallback is silent to the CALLER (parity means the call still just
     * succeeds), but it is logged at `info` so an operator can see how often
     * a host is paying the in-process cost for one-off large documents or a
     * saturated queue — deliberately NOT a status-mode change (`modelStatus()`
     * stays `shared`; this is a per-call accommodation, not a degradation).
     */
    private logParityFallback(err: unknown): void {
        if (!(err instanceof ModelServerError)) return;
        this.log?.info?.('shared model server rejected this call — falling back in-process for this one call (parity)', {
            code: err.code,
            modelId: this.modelId,
        });
    }

    /**
     * 3.24 Part A back-pressure hook (`embed/memoryBudget.ts`) is a purely
     * in-process concern (pauses local embedding while host RSS is over
     * budget). In shared mode the actual model runs in the SERVER process,
     * so this host's own memory pressure is irrelevant to it — a no-op
     * here, matching this slice's task scope ("client-side
     * awaitEmbedMemoryHeadroom is a no-op in shared mode").
     */
    async awaitEmbedMemoryHeadroom(): Promise<void> {
        // Intentional no-op — see doc comment above.
    }

    async initialize(): Promise<void> {
        // Nothing to warm synchronously: the server owns its own model
        // load, and the local fallback is warmed lazily only if needed.
    }

    async embed(text: string): Promise<number[]> {
        return this.embedDocument(text);
    }

    async embedQuery(text: string): Promise<number[]> {
        try {
            const { vectors } = await this.callWithBusyRetry(() =>
                this.client.embed({ op: 'query', modelId: this.modelId, dimension: this.dimension, dtype: this.dtype, text })
            );
            if (vectors && vectors[0]) return vectors[0];
            throw new Error('shared embed(query) returned no vector');
        } catch (err) {
            if (!(err instanceof ModelServerUnavailableError) && !this.isParityFallbackError(err)) throw err;
            this.logParityFallback(err);
            return this.fallback().embedQuery(text);
        }
    }

    async embedDocument(text: string): Promise<number[]> {
        try {
            const { vectors } = await this.callWithBusyRetry(() =>
                this.client.embed({ op: 'document', modelId: this.modelId, dimension: this.dimension, dtype: this.dtype, text })
            );
            if (vectors && vectors[0]) return vectors[0];
            throw new Error('shared embed(document) returned no vector');
        } catch (err) {
            if (!(err instanceof ModelServerUnavailableError) && !this.isParityFallbackError(err)) throw err;
            this.logParityFallback(err);
            return this.fallback().embedDocument(text);
        }
    }

    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        try {
            const { vectors } = await this.callWithBusyRetry(() =>
                this.client.embed({ op: 'documentBatch', modelId: this.modelId, dimension: this.dimension, dtype: this.dtype, texts })
            );
            if (vectors) return vectors;
            throw new Error('shared embed(documentBatch) returned no vectors');
        } catch (err) {
            if (!(err instanceof ModelServerUnavailableError) && !this.isParityFallbackError(err)) throw err;
            this.logParityFallback(err);
            const local = this.fallback();
            if (local.embedDocumentBatch) return local.embedDocumentBatch(texts);
            return Promise.all(texts.map((t) => local.embedDocument(t)));
        }
    }

    async splitIntoWindows(text: string, windowTokens: number, overlapTokens: number): Promise<string[]> {
        try {
            const { windows } = await this.callWithBusyRetry(() =>
                this.client.embed({ op: 'splitIntoWindows', modelId: this.modelId, dimension: this.dimension, dtype: this.dtype, text, windowTokens, overlapTokens })
            );
            if (windows) return windows;
            throw new Error('shared embed(splitIntoWindows) returned no windows');
        } catch (err) {
            if (!(err instanceof ModelServerUnavailableError) && !this.isParityFallbackError(err)) throw err;
            this.logParityFallback(err);
            // Falling back here (rather than degrading the window
            // strategy) is what keeps pieceLayout.ts's splitBody() from
            // ever observing shared vs in-process choose different window
            // strategies for the same input — see this file's commit
            // message and the SF11 note in pieceLayout.ts.
            const local = this.fallback();
            if (local.splitIntoWindows) return local.splitIntoWindows(text, windowTokens, overlapTokens);
            return [text];
        }
    }
}
